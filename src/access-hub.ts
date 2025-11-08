/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-hub.ts: Hub device class for UniFi Access.
 */
import type { AccessDeviceConfig, AccessEventDoorbellCancel, AccessEventDoorbellRing, AccessEventPacket } from "unifi-access";
import type { CharacteristicValue, PlatformAccessory } from "homebridge";
import { acquireService, validService } from "homebridge-plugin-utils";
import type { AccessController } from "./access-controller.js";
import { AccessDevice } from "./access-device.js";
import { AccessReservedNames } from "./access-types.js";

export class AccessHub extends AccessDevice {

  private _hkLockState: CharacteristicValue;
  private doorbellRingRequestId: string | null;
  private lockDelayInterval: number | undefined;
  private readonly deviceClass: string;
  public uda: AccessDeviceConfig;

  // Create an instance.
  constructor(controller: AccessController, device: AccessDeviceConfig, accessory: PlatformAccessory) {

    super(controller, accessory);

    this.uda = device;
    this.deviceClass = (device.device_type ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    this._hkLockState = this.hubLockState;
    this.lockDelayInterval = this.getFeatureNumber(this.featurePrefix + ".LockDelayInterval") ?? undefined;
    this.doorbellRingRequestId = null;

    // If we attempt to set the delay interval to something invalid, then assume we are using the default unlock behavior.
    if((this.lockDelayInterval !== undefined) && (this.lockDelayInterval < 0)) {

      this.lockDelayInterval = undefined;
    }

    this.configureHints();
    this.configureDevice();
  }

  protected get featurePrefix(): string {

    return "Hub";
  }

  protected get lockRelayDescription(): string {

    return "door lock relay";
  }

  private get isG3Reader(): boolean {

    return this.deviceClass.startsWith("UAG3READER");
  }

  protected get positionSensorDisplayName(): string {

    return this.accessoryName + " Door Position Sensor";
  }

  protected get positionSensorLogLabel(): string {

    return "Door position sensor";
  }

  protected get doorbellTriggerDisplayName(): string {

    return this.accessoryName + " Doorbell Trigger";
  }

  protected get lockTriggerDisplayName(): string {

    return this.accessoryName + " Lock Trigger";
  }

  protected get mqttDoorbellLabel(): string {

    return "Doorbell ring";
  }

  protected get mqttDpsLabel(): string {

    return "Door position sensor";
  }

  // Configure device-specific settings for this device.
  protected configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.hasDps = this.hasCapability([ "dps_alarm", "dps_mode_selectable", "dps_trigger_level" ]) &&
      this.hasFeature(this.featurePrefix + ".DPS");
    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logDps = this.hasFeature("Log.DPS");
    this.hints.logLock = this.hasFeature("Log.Lock");

    return true;
  }

  // Initialize and configure the light accessory for HomeKit.
  private configureDevice(): boolean {

    this._hkLockState = this.hubLockState;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.uda.mac;
    this.accessory.context.controller = this.controller.uda.host.mac;

    if(this.lockDelayInterval === undefined) {

      this.log.info("The %s will lock five seconds after unlocking in HomeKit.", this.lockRelayDescription);
    } else {

      this.log.info("The %s will remain unlocked %s after unlocking in HomeKit.", this.lockRelayDescription,
        this.lockDelayInterval === 0 ? "indefinitely" : "for " + this.lockDelayInterval.toString() + " minutes");
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure the lock.
    this.configureLock();
    this.configureLockTrigger();

    // Configure the doorbell.
    this.configureDoorbell();
    this.configureDoorbellTrigger();

    // Configure the door position sensor.
    this.configureDps();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.controller.events.on(this.uda.unique_id, this.listeners[this.uda.unique_id] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_view", this.listeners["access.remote_view"] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_call", this.listeners["access.remote_call"] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_view.change", this.listeners["access.remote_view.change"] = this.eventHandler.bind(this));
    this.controller.events.on("access.remote_call.change", this.listeners["access.remote_call.change"] = this.eventHandler.bind(this));

    return true;
  }

  // Configure the doorbell service for HomeKit.
  private configureDoorbell(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Doorbell, this.hasCapability("door_bell") && this.hasFeature("Hub.Doorbell"))) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Doorbell, this.accessoryName, undefined, () => this.log.info("Enabling the doorbell."));

    if(!service) {

      this.log.error("Unable to add the doorbell.");

      return false;
    }

    service.setPrimaryService(true);

    return true;
  }

  // Configure the door position sensor for HomeKit.
  private configureDps(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.ContactSensor, this.hints.hasDps, AccessReservedNames.CONTACT_DPS)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.ContactSensor, this.positionSensorDisplayName,
      AccessReservedNames.CONTACT_DPS, () => this.log.info("Enabling the %s.", this.positionSensorLogLabel.toLowerCase()));

    if(!service) {

      this.log.error("Unable to add the %s.", this.positionSensorLogLabel.toLowerCase());

      return false;
    }

    // Initialize the light.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hubDpsState);

    return true;
  }

  // Configure the lock for HomeKit.
  private configureLock(): boolean {

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.LockMechanism, this.accessoryName);

    if(!service) {

      this.log.error("Unable to add the lock.");

      return false;
    }

    // Return the lock state.
    service.getCharacteristic(this.hap.Characteristic.LockCurrentState)?.onGet(() => this.hkLockState);

    service.getCharacteristic(this.hap.Characteristic.LockTargetState)?.onSet(async (value: CharacteristicValue) => {

      if(!(await this.hubLockCommand(value === this.hap.Characteristic.LockTargetState.SECURED))) {

        // Revert our target state.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.LockTargetState, !value), 50);
      }

      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hkLockState);
    });

    // Initialize the lock.
    this._hkLockState = -1;
    service.displayName = this.accessoryName;
    service.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
    this.hkLockState = this.hubLockState;

    service.setPrimaryService(true);

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hasCapability("door_bell") && this.hasFeature(this.featurePrefix + ".Doorbell.Trigger"),
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Switch, this.doorbellTriggerDisplayName,
      AccessReservedNames.SWITCH_DOORBELL_TRIGGER, () => this.log.info("Enabling the doorbell automation trigger."));

    if(!service) {

      this.log.error("Unable to add the doorbell automation trigger.");

      return false;
    }

    // Trigger the doorbell.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.doorbellRingRequestId !== null);

    // The state isn't really user-triggerable. We have no way, currently, to trigger a ring event on the hub.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(() => {

      setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, this.doorbellRingRequestId !== null), 50);
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.doorbellTriggerDisplayName);
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure a switch to automate lock and unlock events in HomeKit beyond what HomeKit might allow for a lock service that gets treated as a secure service.
  private configureLockTrigger(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hasFeature(this.featurePrefix + ".Lock.Trigger"), AccessReservedNames.SWITCH_LOCK_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Switch, this.lockTriggerDisplayName,
      AccessReservedNames.SWITCH_LOCK_TRIGGER, () => this.log.info("Enabling the lock automation trigger."));

    if(!service) {

      this.log.error("Unable to add the lock automation trigger.");

      return false;
    }

    // Trigger the doorbell.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.hkLockState !== this.hap.Characteristic.LockCurrentState.SECURED);

    // The state isn't really user-triggerable. We have no way, currently, to trigger a lock or unlock event on the hub.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // If we are on, we are in an unlocked state. If we are off, we are in a locked state.
      if(!(await this.hubLockCommand(!value))) {

        // Revert our state.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), 50);
      }
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.lockTriggerDisplayName);
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    const lockService = this.accessory.getService(this.hap.Service.LockMechanism);

    if(!lockService) {

      return false;
    }

    // MQTT doorbell status.
    this.controller.mqtt?.subscribeGet(this.id, "doorbell", this.mqttDoorbellLabel, () => {

      return this.doorbellRingRequestId !== null ? "true" : "false";
    });

    // MQTT DPS status.
    this.controller.mqtt?.subscribeGet(this.id, "dps", this.mqttDpsLabel, () => {

      if(!this.isDpsWired) {

        return "unknown";
      }

      switch(this.hkDpsState) {

        case this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED:

          return "false";


        case this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED:

          return "true";

        default:

          return "unknown";
      }
    });

    // MQTT lock status.
    this.controller.mqtt?.subscribeGet(this.id, "lock", "Lock", () => {

      switch(this.hkLockState) {

        case this.hap.Characteristic.LockCurrentState.SECURED:

          return "true";

        case this.hap.Characteristic.LockCurrentState.UNSECURED:

          return "false";

        default:

          return "unknown";
      }
    });

    // MQTT lock status.
    this.controller.mqtt?.subscribeSet(this.id, "lock", "Lock", (value: string) => {

      switch(value) {

        case "true":

          void this.controller.udaApi.unlock(this.uda, 0);

          break;

        case "false":

          void this.controller.udaApi.unlock(this.uda, Infinity);

          break;

        default:

          this.log.error("MQTT: Unknown lock set message received: %s.", value);

          break;
      }
    });

    return true;
  }

  // Utility function to execute lock and unlock actions on a hub.
  private async hubLockCommand(isLocking: boolean): Promise<boolean> {

    const action = isLocking ? "lock" : "unlock";

    let unlockDuration: number | undefined;

    if(isLocking) {

      unlockDuration = 0;
    } else if(this.lockDelayInterval === undefined) {

      unlockDuration = undefined;
    } else if(this.lockDelayInterval === 0) {

      unlockDuration = Infinity;
    } else {

      unlockDuration = this.lockDelayInterval;
    }

    // If we're not online, we're done.
    if(!this.isOnline) {

      this.log.error("Unable to %s. Device is offline.", action);

      return false;
    }

    // Execute the action.
    const device: AccessDeviceConfig = (this.isG3Reader && !this.uda.capabilities?.includes("is_hub")) ?
      { ...this.uda, capabilities: [ ...(this.uda.capabilities ?? []), "is_hub" ] } :
      this.uda;

    if(!(await this.controller.udaApi.unlock(device, unlockDuration))) {
      
      this.log.error("Unable to %s.", action);

      return false;
    }

    return true;
  }

  // Return the current HomeKit DPS state that we are tracking for this hub.
  private get hkDpsState(): CharacteristicValue {

    return this.accessory.getService(this.hap.Service.ContactSensor)?.getCharacteristic(this.hap.Characteristic.ContactSensorState).value ??
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Set the current HomeKit DPS state for this hub.
  private set hkDpsState(value: CharacteristicValue) {

    // Update the state of the contact service.
    this.accessory.getService(this.hap.Service.ContactSensor)?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, value);
  }

  // Return the current HomeKit lock state that we are tracking for this hub.
  private get hkLockState(): CharacteristicValue {

    return this._hkLockState;
  }

  // Set the current HomeKit lock state for this hub.
  private set hkLockState(value: CharacteristicValue) {

    // If nothing is changed, we're done.
    if(this.hkLockState === value) {

      return;
    }

    // Update the lock state.
    this._hkLockState = value;

    // Retrieve the lock service.
    const lockService = this.accessory.getService(this.hap.Service.LockMechanism);

    if(!lockService) {

      return;
    }

    // Update the state in HomeKit.
    lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hkLockState === this.hap.Characteristic.LockCurrentState.UNSECURED ?
      this.hap.Characteristic.LockTargetState.UNSECURED : this.hap.Characteristic.LockTargetState.SECURED);
    lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hkLockState);
    this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_LOCK_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On,
      this.hkLockState !== this.hap.Characteristic.LockCurrentState.SECURED);
  }

  // Return the current state of the DPS on the hub.
  private get hubDpsState(): CharacteristicValue {

    // If we don't have the wiring connected for the DPS, we report our default closed state.
    if(!this.isDpsWired) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    let relayType;

    switch(this.uda.device_type) {

      case "UA-Hub-Door-Mini":
      case "UA-ULTRA":

        relayType = "input_d1_dps";

        break;

      default:

        relayType = "input_state_dps";

        break;
    }

    // Return our DPS state. If it's anything other than on, we assume it's open.
    return (this.uda.configs?.find(x => x.key === relayType)?.value === "on") ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED :
      this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // Return the current state of the relay lock on the hub.
  private get hubLockState(): CharacteristicValue {

    let relayType;

    switch(this.uda.device_type) {

      case "UA-Hub-Door-Mini":
      case "UA-ULTRA":

        relayType = "output_d1_lock_relay";

        break;

      default:

        relayType = "input_state_rly-lock_dry";

        break;
    }

    const lockRelayValue = this.uda.configs?.find(x => x.key === relayType)?.value;

    if(lockRelayValue === undefined || lockRelayValue === null) {

      return this.isG3Reader ? this.hap.Characteristic.LockCurrentState.SECURED :
        this.hap.Characteristic.LockCurrentState.UNKNOWN;
    }

    const normalizedRelayValue = typeof lockRelayValue === "string" ? lockRelayValue.toLowerCase() : lockRelayValue;
    let isRelayActive = false;
    let isRelayInactive = false;

    switch(typeof normalizedRelayValue) {

      case "boolean":

        isRelayActive = normalizedRelayValue;
        isRelayInactive = !normalizedRelayValue;

        break;

      case "number":

        isRelayActive = normalizedRelayValue === 1;
        isRelayInactive = normalizedRelayValue === 0;

        break;

      case "string":

        isRelayActive = ["on", "true", "unlocked", "open", "active"].includes(normalizedRelayValue);
        isRelayInactive = ["off", "false", "locked", "closed", "inactive", "secured"].includes(normalizedRelayValue);

        break;

      default:

        break;
    }

    if(isRelayInactive) {

      return this.hap.Characteristic.LockCurrentState.SECURED;
    }

    if(isRelayActive) {

      return this.hap.Characteristic.LockCurrentState.UNSECURED;
    }

    if(this.isG3Reader) {

      return this.hap.Characteristic.LockCurrentState.SECURED;
    }

    return this.hap.Characteristic.LockCurrentState.UNKNOWN;
  }

  // Return whether the DPS has been wired on the hub.
  private get isDpsWired(): boolean {

    let wiringType = [];

    switch(this.uda.device_type) {

      case "UA-Hub-Door-Mini":

        wiringType = [ "wiring_state_d1-dps-neg", "wiring_state_d1-dps-pos" ];

        break;

      case "UAH":

        wiringType = [ "wiring_state_dps-neg", "wiring_state_dps-pos" ];

        break;

      case "UA-ULTRA":

        return true;

      default:

        // By default, let's assume the wiring is not there.
        return false;
    }

    // The DPS is considered wired only if all associated wiring is connected.
    return wiringType.filter(wire => this.uda.configs?.some(x => x.key === wire && x.value === "on")).length === wiringType.length;
  }

  // Utility to validate hub capabilities.
  private hasCapability(capability: string | string[]): boolean {

    return Array.isArray(capability) ? capability.some(c => this.uda?.capabilities?.includes(c)) : this.uda?.capabilities?.includes(capability);
  }

  private isDoorbellEventForDevice(packet: AccessEventPacket): boolean {

    if(!this.hasCapability("door_bell")) {

      return false;
    }

    const ringEvent = packet.data as AccessEventDoorbellRing;
    const uniqueId = this.uda.unique_id;

    return (ringEvent.connected_uah_id === uniqueId) || (ringEvent.device_id === uniqueId) || (packet.event_object_id === uniqueId);
  }

  // Handle hub-related events.
  private eventHandler(packet: AccessEventPacket): void {

    switch(packet.event) {

      case "access.data.device.remote_unlock":

        // Process an Access unlock event.
        this.hkLockState = this.hap.Characteristic.LockCurrentState.UNSECURED;

        // Publish to MQTT, if configured to do so.
        this.controller.mqtt?.publish(this.id, "lock", "false");

        if(this.hints.logLock) {

          this.log.info("Unlocked.");
        }

        break;

      case "access.data.device.update":

        // Process a lock update event if our state has changed.
        if(this.hubLockState !== this.hkLockState) {

          this.hkLockState = this.hubLockState;

          this.controller.mqtt?.publish(this.id, "lock", this.hkLockState === this.hap.Characteristic.LockCurrentState.SECURED ? "true" : "false");

          if(this.hints.logLock) {

            this.log.info(this.hkLockState === this.hap.Characteristic.LockCurrentState.SECURED ? "Locked." : "Unlocked.");
          }
        }

        // Process a DPS update event if our state has changed.
        if(this.hints.hasDps && (this.hubDpsState !== this.hkDpsState)) {

          this.hkDpsState = this.hubDpsState;

          // Publish to MQTT, if configured to do so.
          if(this.isDpsWired) {

            this.controller.mqtt?.publish(this.id, "dps", (this.hkDpsState === this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED) ? "false" : "true");

            if(this.hints.logDps) {

              this.log.info("%s %s.", this.positionSensorLogLabel,
                (this.hkDpsState === this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED) ? "closed" : "open");
            }
          }
        }

        break;

      case "access.remote_view":
      case "access.remote_call":

        // Process an Access ring event if we're the intended target.
        if(!this.isDoorbellEventForDevice(packet)) {

          break;
        }

        this.doorbellRingRequestId = (packet.data as AccessEventDoorbellRing).request_id;

        // Trigger the doorbell event in HomeKit.
        this.accessory.getService(this.hap.Service.Doorbell)?.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
          ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        // Update our doorbell trigger, if needed.
        this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, true);

        // Publish to MQTT, if configured to do so.
        this.controller.mqtt?.publish(this.id, "doorbell", "true");

        if(this.hints.logDoorbell) {

          this.log.info("Doorbell ring detected.");
        }

        break;

      case "access.remote_view.change":
      case "access.remote_call.change":

        // Process the cancellation of an Access ring event if we're the intended target.
        if(this.doorbellRingRequestId !== (packet.data as AccessEventDoorbellCancel).remote_call_request_id) {

          break;
        }

        this.doorbellRingRequestId = null;

        // Update our doorbell trigger, if needed.
        this.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, false);

        // Publish to MQTT, if configured to do so.
        this.controller.mqtt?.publish(this.id, "doorbell", "false");

        if(this.hints.logDoorbell) {

          this.log.info("Doorbell ring cancelled.");
        }

        break;

      default:

        break;
    }
  }
}
