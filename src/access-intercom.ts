/* Copyright(C) 2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-intercom.ts: Intercom device class for UniFi Access.
 */
import type * as Homebridge from "homebridge";
import { type AccessDeviceConfig, type AccessEventDoorbellCancel, type AccessEventDoorbellRing, type AccessEventPacket } from "unifi-access";
import { acquireService, validService } from "homebridge-plugin-utils";
import type { AccessController } from "./access-controller.js";
import { AccessDevice } from "./access-device.js";
import { AccessReservedNames } from "./access-types.js";

export class AccessIntercom extends AccessDevice {

  private doorbellRingRequestId: string | null;
  private readonly deviceClass: string;
  public uda: AccessDeviceConfig;

  constructor(controller: AccessController, device: AccessDeviceConfig, accessory: Homebridge.PlatformAccessory) {

    super(controller, accessory);

    this.uda = device;
    this.deviceClass = (device.device_type ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    this.doorbellRingRequestId = null;

    this.configureHints();
    this.configureDevice();
  }

  protected configureHints(): boolean {

    super.configureHints();

    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");

    return true;
  }

  private configureDevice(): boolean {

    this.accessory.context = {};
    this.accessory.context.mac = this.uda.mac;
    this.accessory.context.controller = this.controller.uda.host.mac;

    this.configureInfo();

    this.configureDoorbell();
    this.configureDoorbellTrigger();
    this.configureMqtt();

    this.controller.events.on("access.remote_view", this.listeners["access.remote_view"] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_call", this.listeners["access.remote_call"] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_view.change", this.listeners["access.remote_view.change"] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_call.change", this.listeners["access.remote_call.change"] = this.eventHandler.bind(this));

    return true;
  }

  private configureDoorbell(): boolean {

    if(!validService(this.accessory, this.hap.Service.Doorbell, this.isDoorbellCapable && this.hasFeature("Intercom.Doorbell"))) {

      return false;
    }

    const service = acquireService(this.hap, this.accessory, this.hap.Service.Doorbell, this.accessoryName, undefined, () => this.log.info("Enabling the doorbell."));

    if(!service) {

      this.log.error("Unable to add the doorbell.");

      return false;
    }

    service.setPrimaryService(true);

    return true;
  }

  private configureDoorbellTrigger(): boolean {

    if(!validService(this.accessory, this.hap.Service.Switch, this.isDoorbellCapable && this.hasFeature("Intercom.Doorbell.Trigger"),
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER)) {

      return false;
    }

    const service = acquireService(this.hap, this.accessory, this.hap.Service.Switch, this.doorbellTriggerDisplayName,
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER, () => this.log.info("Enabling the doorbell automation trigger."));

    if(!service) {

      this.log.error("Unable to add the doorbell automation trigger.");

      return false;
    }

    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.doorbellRingRequestId !== null);
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(() => {

      setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, this.doorbellRingRequestId !== null), 50);
    });

    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.doorbellTriggerDisplayName);
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  private configureMqtt(): boolean {

    this.controller.mqtt?.subscribeGet(this.id, "doorbell", "Doorbell ring", () => this.doorbellRingRequestId !== null ? "true" : "false");

    return true;
  }

  private get doorbellTriggerDisplayName(): string {

    return this.accessoryName + " Doorbell Trigger";
  }

  private eventHandler(packet: AccessEventPacket): void {

    switch(packet.event) {

      case "access.remote_view":
      case "access.remote_call":

        if(!this.isDoorbellEventForDevice(packet)) {

          break;
        }

        this.doorbellRingRequestId = (packet.data as AccessEventDoorbellRing).request_id;

        this.accessory.getService(this.hap.Service.Doorbell)?.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
          ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)
          ?.updateCharacteristic(this.hap.Characteristic.On, true);

        this.controller.mqtt?.publish(this.id, "doorbell", "true");

        if(this.hints.logDoorbell) {

          this.log.info("Doorbell ring detected.");
        }

        break;

      case "access.remote_view.change":
      case "access.remote_call.change":

        if(this.doorbellRingRequestId !== (packet.data as AccessEventDoorbellCancel).remote_call_request_id) {

          break;
        }

        this.doorbellRingRequestId = null;

        this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)
          ?.updateCharacteristic(this.hap.Characteristic.On, false);

        this.controller.mqtt?.publish(this.id, "doorbell", "false");

        if(this.hints.logDoorbell) {

          this.log.info("Doorbell ring cancelled.");
        }

        break;

      default:

        break;
    }
  }

  private hasCapability(capability: string | string[]): boolean {

    return Array.isArray(capability) ? capability.some(c => this.uda?.capabilities?.includes(c)) : this.uda?.capabilities?.includes(capability);
  }

  private get isDoorbellCapable(): boolean {

    return this.hasCapability("door_bell") || (this.deviceClass === "UAG3INTERCOM");
  }

  private isDoorbellEventForDevice(packet: AccessEventPacket): boolean {

    if(!this.isDoorbellCapable) {

      return false;
    }

    const ringEvent = packet.data as AccessEventDoorbellRing;
    const uniqueId = this.uda.unique_id;

    return (ringEvent.connected_uah_id === uniqueId) || (ringEvent.device_id === uniqueId) || (packet.event_object_id === uniqueId);
  }
}
