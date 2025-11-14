/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-hub.ts: Hub device class for UniFi Access.
 */
import type { AccessDeviceConfig, AccessDeviceConfigPayload, AccessEventDoorbellCancel, AccessEventDoorbellRing, AccessEventPacket } from "unifi-access";
import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { acquireService, validService } from "homebridge-plugin-utils";
import type { AccessController } from "./access-controller.js";
import { AccessDevice } from "./access-device.js";
import { AccessReservedNames } from "./access-types.js";
import { isG3ReaderDeviceClass } from "./access-types.js";
import util from "node:util";

const DEFAULT_LOCK_RESET_DELAY = 5000;
const G3_READER_LOCK_RESET_DELAY = 2000;
const LOCK_RESET_MAX_ATTEMPTS = 6;
const LOCK_RESET_RETRY_DELAY = 5000;

type DryContactSensorType = "rel" | "ren" | "rex";

interface DryContactSensorDefinition {

  displayNameSuffix: string,
  logLabel: string,
  mqttLabel: string,
  reservedName: AccessReservedNames,
  stateKeys: { default: string, mini?: string },
  wiringKeys: { default: string[], mini?: string[] }
}

type AccessMethodType = "face" | "hand" | "mobile" | "nfc" | "pin" | "qr";

interface AccessMethodSwitchDefinition {

  configKey: string,
  extensionKey: string,
  methodType: AccessMethodType,
  state: boolean
}

type AccessDeviceExtension = NonNullable<AccessDeviceConfig["extensions"]>[number];

const ACCESS_METHOD_METADATA: Record<AccessMethodType, {

  displayNameSuffix: string,
  keywords: string[],
  logLabel: string,
  reservedName: AccessReservedNames
}> = {

  face: {

    displayNameSuffix: " Face Access",
    keywords: [ "face" ],
    logLabel: "Face access method",
    reservedName: AccessReservedNames.SWITCH_METHOD_FACE
  },

  hand: {

    displayNameSuffix: " Hand-Wave Access",
    keywords: [ "hand", "wave" ],
    logLabel: "Hand-wave access method",
    reservedName: AccessReservedNames.SWITCH_METHOD_HAND
  },

  mobile: {

    displayNameSuffix: " Mobile Access",
    keywords: [ "mobile" ],
    logLabel: "Mobile access method",
    reservedName: AccessReservedNames.SWITCH_METHOD_MOBILE
  },

  nfc: {

    displayNameSuffix: " NFC Access",
    keywords: [ "nfc" ],
    logLabel: "NFC access method",
    reservedName: AccessReservedNames.SWITCH_METHOD_NFC
  },

  pin: {

    displayNameSuffix: " PIN Access",
    keywords: [ "pin" ],
    logLabel: "PIN access method",
    reservedName: AccessReservedNames.SWITCH_METHOD_PIN
  },

  qr: {

    displayNameSuffix: " QR Access",
    keywords: [ "qr" ],
    logLabel: "QR access method",
    reservedName: AccessReservedNames.SWITCH_METHOD_QR
  }
};

const ACCESS_METHOD_TYPES = Object.keys(ACCESS_METHOD_METADATA) as AccessMethodType[];

const DRY_CONTACT_SENSOR_TYPES: DryContactSensorType[] = [ "rel", "ren", "rex" ];

const DRY_CONTACT_SENSOR_DEFINITIONS: Record<DryContactSensorType, DryContactSensorDefinition> = {

  rel: {

    displayNameSuffix: " REL Sensor",
    logLabel: "REL dry contact sensor",
    mqttLabel: "REL sensor",
    reservedName: AccessReservedNames.CONTACT_REL,
    stateKeys: { default: "input_state_rel", mini: "input_d1_rel" },
    wiringKeys: { default: [ "wiring_state_rel-neg", "wiring_state_rel-pos" ], mini: [ "wiring_state_d1-rel-neg", "wiring_state_d1-rel-pos" ] }
  },

  ren: {

    displayNameSuffix: " REN Sensor",
    logLabel: "REN dry contact sensor",
    mqttLabel: "REN sensor",
    reservedName: AccessReservedNames.CONTACT_REN,
    stateKeys: { default: "input_state_ren", mini: "input_d1_ren" },
    wiringKeys: { default: [ "wiring_state_ren-neg", "wiring_state_ren-pos" ], mini: [ "wiring_state_d1-ren-neg", "wiring_state_d1-ren-pos" ] }
  },

  rex: {

    displayNameSuffix: " REX Sensor",
    logLabel: "REX dry contact sensor",
    mqttLabel: "REX sensor",
    reservedName: AccessReservedNames.CONTACT_REX,
    stateKeys: { default: "input_state_rex", mini: "input_d1_rex" },
    wiringKeys: { default: [ "wiring_state_rex-neg", "wiring_state_rex-pos" ], mini: [ "wiring_state_d1-rex-neg", "wiring_state_d1-rex-pos" ] }
  }
};

export class AccessHub extends AccessDevice {

  private _hkLockState: CharacteristicValue;
  private doorbellRingRequestId: string | null;
  private lockDelayInterval: number | undefined;
  private lockResetTimer: NodeJS.Timeout | null;
  private g3ReaderLockStateOverride: CharacteristicValue | null;
  private readonly deviceClass: string;
  private readonly accessMethodConfigs: Map<AccessMethodType, AccessMethodSwitchDefinition>;
  private readonly accessMethodStates: Map<AccessMethodType, boolean>;
  private readonly dryContactStates: Partial<Record<DryContactSensorType, CharacteristicValue>>;
  public uda: AccessDeviceConfig;

  // Create an instance.
  constructor(controller: AccessController, device: AccessDeviceConfig, accessory: PlatformAccessory) {

    super(controller, accessory);

    this.uda = device;
    this.deviceClass = (device.device_type ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    this._hkLockState = this.hubLockState;
    const configuredLockDelay = this.getFeatureNumber(this.featurePrefix + ".LockDelayInterval") ?? undefined;

    if(this.isG3Reader && (configuredLockDelay !== undefined)) {

      const lockDelayDescription = configuredLockDelay === 0 ? "an indefinite unlock interval" :
        "a " + configuredLockDelay.toString() + " minute unlock interval";

      this.log.warn("The %s does not support %s. Falling back to the default unlock behavior.",
        this.lockRelayDescription, lockDelayDescription);
    }

    this.lockDelayInterval = this.isG3Reader ? undefined : configuredLockDelay;
    this.lockResetTimer = null;
    this.doorbellRingRequestId = null;
    this.g3ReaderLockStateOverride = null;
    this.accessMethodConfigs = new Map();
    this.accessMethodStates = new Map();
    this.dryContactStates = {};

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

    return isG3ReaderDeviceClass(this.deviceClass);
  }

  private get supportsAccessMethods(): boolean {

    return (this.uda.extensions?.length ?? 0) > 0;
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
    this.hints.hasRel = this.hasDryContactSensor("rel");
    this.hints.hasRen = this.hasDryContactSensor("ren");
    this.hints.hasRex = this.hasDryContactSensor("rex");
    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logDps = this.hasFeature("Log.DPS");
    this.hints.logRel = this.hasFeature("Log.REL");
    this.hints.logRen = this.hasFeature("Log.REN");
    this.hints.logRex = this.hasFeature("Log.REX");
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
    this.configureAccessMethodSwitches();

    if(this.isG3Reader) {

      const locationId = this.uda.location_id ?? this.uda.door?.unique_id;

      if(locationId) {

        this.controller.events.on(locationId, this.listeners[locationId] = this.eventHandler.bind(this));
      }
    }

    // Configure the door position sensor.
    this.configureDps();
    this.configureDryContacts();

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

  public override cleanup(): void {

    if(this.lockResetTimer) {

      clearTimeout(this.lockResetTimer);
      this.lockResetTimer = null;
    }

    super.cleanup();
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

  private configureDryContacts(): void {

    for(const sensorType of DRY_CONTACT_SENSOR_TYPES) {

      this.configureDryContactSensor(sensorType);
    }
  }

  private configureDryContactSensor(sensorType: DryContactSensorType): void {

    const hasSensor = this.getDryContactHint(sensorType, "has");

    if(!validService(this.accessory, this.hap.Service.ContactSensor, hasSensor,
      this.getDryContactDefinition(sensorType).reservedName)) {

      return;
    }

    const definition = this.getDryContactDefinition(sensorType);
    const displayName = this.getDryContactDisplayName(sensorType);
    const service = acquireService(this.hap, this.accessory, this.hap.Service.ContactSensor, displayName,
      definition.reservedName, () => this.log.info("Enabling the %s.", definition.logLabel));

    if(!service) {

      this.log.error("Unable to add the %s.", definition.logLabel);

      return;
    }

    service.updateCharacteristic(this.hap.Characteristic.Name, displayName);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline && this.isDryContactWired(sensorType));

    const initialState = this.getDryContactState(sensorType);

    this.dryContactStates[sensorType] = initialState;
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, initialState);
  }

  private configureDryContactMqtt(sensorType: DryContactSensorType): void {

    if(!this.getDryContactHint(sensorType, "has")) {

      return;
    }

    this.controller.mqtt?.subscribeGet(this.id, sensorType, this.getDryContactDefinition(sensorType).mqttLabel, () => {

      if(!this.isDryContactWired(sensorType)) {

        return "unknown";
      }

      const state = this.dryContactStates[sensorType] ?? this.getDryContactState(sensorType);

      switch(state) {

        case this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED:

          return "false";

        case this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED:

          return "true";

        default:

          return "unknown";
      }
    });
  }

  private configureAccessMethodSwitches(): void {

    if(!this.supportsAccessMethods) {

      return;
    }

    for(const definition of this.discoverAccessMethodDefinitions()) {

      this.accessMethodConfigs.set(definition.methodType, definition);
      this.configureAccessMethodSwitch(definition);
    }
  }

  private configureAccessMethodSwitch(definition: AccessMethodSwitchDefinition): void {

    const reservedName = this.getAccessMethodReservedName(definition.methodType);
    const displayName = this.getAccessMethodDisplayName(definition.methodType);
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Switch, displayName,
      reservedName, () => this.log.info("Enabling the %s.", this.getAccessMethodLogLabel(definition.methodType).toLowerCase()));

    if(!service) {

      this.log.error("Unable to add the %s.", this.getAccessMethodLogLabel(definition.methodType).toLowerCase());

      return;
    }

    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.accessMethodStates.get(definition.methodType) ??
      definition.state);

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      const targetState = value === true;
      const currentState = this.accessMethodStates.get(definition.methodType) ?? definition.state;

      if(targetState === currentState) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, currentState), 50);

        return;
      }

      if(!(await this.updateAccessMethodConfig(definition.methodType, targetState))) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On,
          this.accessMethodStates.get(definition.methodType) ?? currentState), 50);

        return;
      }

      this.logAccessMethodState(definition.methodType, targetState);
    });

    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, displayName);
    service.updateCharacteristic(this.hap.Characteristic.On, definition.state);

    this.accessMethodStates.set(definition.methodType, definition.state);
  }

  private refreshAccessMethodSwitches(): void {

    if(!this.supportsAccessMethods) {

      if(this.accessMethodStates.size) {

        for(const methodType of Array.from(this.accessMethodStates.keys())) {

          this.accessMethodStates.delete(methodType);
          this.accessMethodConfigs.delete(methodType);
          this.getAccessMethodService(methodType)?.updateCharacteristic(this.hap.Characteristic.On, false);
        }
      }

      return;
    }

    const definitions = this.discoverAccessMethodDefinitions();
    const activeMethods = new Set<AccessMethodType>();

    for(const definition of definitions) {

      activeMethods.add(definition.methodType);
      const previousState = this.accessMethodStates.get(definition.methodType);

      this.accessMethodConfigs.set(definition.methodType, definition);

      const service = this.getAccessMethodService(definition.methodType);

      if(!service) {

        this.configureAccessMethodSwitch(definition);

        continue;
      }

      if(previousState === definition.state) {

        continue;
      }

      this.accessMethodStates.set(definition.methodType, definition.state);
      service.updateCharacteristic(this.hap.Characteristic.On, definition.state);
      this.logAccessMethodState(definition.methodType, definition.state);
    }

    for(const methodType of Array.from(this.accessMethodStates.keys())) {

      if(activeMethods.has(methodType)) {

        continue;
      }

      this.accessMethodStates.delete(methodType);
      this.accessMethodConfigs.delete(methodType);
      this.getAccessMethodService(methodType)?.updateCharacteristic(this.hap.Characteristic.On, false);
    }
  }

  private discoverAccessMethodDefinitions(): AccessMethodSwitchDefinition[] {

    const extensions = this.uda.extensions;

    if(!extensions?.length) {

      return [];
    }

    const seen = new Set<AccessMethodType>();
    const definitions: AccessMethodSwitchDefinition[] = [];

    for(const extension of extensions) {

      const methodType = this.getAccessMethodTypeFromExtension(extension);

      if(!methodType || seen.has(methodType)) {

        continue;
      }

      const configEntry = extension.target_config?.find(config => typeof config.config_value === "boolean");

      if(typeof configEntry?.config_value !== "boolean") {

        continue;
      }

      const extensionKey = this.buildAccessMethodExtensionKey(extension, methodType);

      definitions.push({

        configKey: configEntry.config_key,
        extensionKey,
        methodType,
        state: configEntry.config_value
      });

      seen.add(methodType);
    }

    return definitions;
  }

  private getAccessMethodTypeFromExtension(extension: AccessDeviceExtension): AccessMethodType | null {

    const values = [ extension.extension_name, extension.target_name, extension.target_type, extension.target_value,
      extension.source_id ]
      .map(value => typeof value === "string" ? value.toLowerCase() : "");

    for(const methodType of ACCESS_METHOD_TYPES) {

      const keywords = ACCESS_METHOD_METADATA[methodType].keywords;

      if(keywords.some(keyword => values.some(value => value.includes(keyword)))) {

        return methodType;
      }
    }

    return null;
  }

  private buildAccessMethodExtensionKey(extension: AccessDeviceExtension, fallback: string): string {

    return extension.unique_id ?? extension.device_id ?? extension.target_name ?? extension.extension_name ?? extension.source_id ?? fallback;
  }

  private getAccessMethodDisplayName(methodType: AccessMethodType): string {

    return this.accessoryName + ACCESS_METHOD_METADATA[methodType].displayNameSuffix;
  }

  private getAccessMethodLogLabel(methodType: AccessMethodType): string {

    return ACCESS_METHOD_METADATA[methodType].logLabel;
  }

  private getAccessMethodReservedName(methodType: AccessMethodType): AccessReservedNames {

    return ACCESS_METHOD_METADATA[methodType].reservedName;
  }

  private getAccessMethodService(methodType: AccessMethodType): Service | undefined {

    return this.accessory.getServiceById(this.hap.Service.Switch, this.getAccessMethodReservedName(methodType));
  }

  private async updateAccessMethodConfig(methodType: AccessMethodType, targetState: boolean): Promise<boolean> {

    const definition = this.accessMethodConfigs.get(methodType);
    const extensions = this.uda.extensions;

    if(!definition || !extensions?.length) {

      return false;
    }

    const updatedExtensions = extensions.map(extension => {

      if(!this.isMatchingAccessMethodExtension(extension, definition)) {

        return extension;
      }

      return {

        ...extension,
        // eslint-disable-next-line camelcase
        target_config: extension.target_config?.map(config => {

          if(config.config_key !== definition.configKey) {

            return config;
          }

          // eslint-disable-next-line camelcase
          return { ...config, config_value: targetState };
        })
      };
    });

    const payload: AccessDeviceConfigPayload = {

      extensions: updatedExtensions
    };

    const updatedDevice = await this.controller.udaApi.updateDevice(this.uda, payload);

    if(!updatedDevice) {

      return false;
    }

    this.uda = updatedDevice;
    this.accessMethodConfigs.set(methodType, { ...definition, state: targetState });
    this.accessMethodStates.set(methodType, targetState);

    return true;
  }

  private isMatchingAccessMethodExtension(extension: AccessDeviceExtension, definition: AccessMethodSwitchDefinition): boolean {

    return this.buildAccessMethodExtensionKey(extension, definition.methodType) === definition.extensionKey;
  }

  private logAccessMethodState(methodType: AccessMethodType, isEnabled: boolean): void {

    this.log.info("%s %s.", this.getAccessMethodLogLabel(methodType), isEnabled ? "enabled" : "disabled");
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

    for(const sensorType of DRY_CONTACT_SENSOR_TYPES) {

      this.configureDryContactMqtt(sensorType);
    }

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
    const device = this.getCommandDeviceConfig();

    if(!device) {

      this.log.error("Unable to %s. Command device configuration is not available.", action);

      return false;
    }

    if(isLocking && this.lockResetTimer) {

      clearTimeout(this.lockResetTimer);
      this.lockResetTimer = null;
    }

    const isDefaultUnlock = !isLocking && (this.lockDelayInterval === undefined);
    let commandSucceeded: boolean;

    if(this.isG3Reader && (unlockDuration === 0)) {

      commandSucceeded = await this.lockG3Reader(device);
    } else {

      commandSucceeded = await this.controller.udaApi.unlock(device, unlockDuration);
    }

    if(!commandSucceeded) {

      this.log.error("Unable to %s.", action);

      return false;
    }

    const targetState = isLocking ? this.hap.Characteristic.LockCurrentState.SECURED :
      this.hap.Characteristic.LockCurrentState.UNSECURED;

    if(this.isG3Reader) {

      this.g3ReaderLockStateOverride = targetState;

    }

    if(this.hkLockState !== targetState) {

      this.hkLockState = targetState;

    }

    if(isDefaultUnlock) {

      this.scheduleDefaultLockReset(device);
    }

    return true;
  }

  private getCommandDeviceConfig(): AccessDeviceConfig | null {

    if(this.uda.capabilities?.includes("is_hub")) {

      return this.uda;
    }

    if(!this.isG3Reader) {

      return null;
    }

    const capabilities = [ ...(this.uda.capabilities ?? []), "is_hub" ];
    const locationId = this.uda.location_id ?? this.uda.door?.unique_id;

    if(!locationId && !this.uda.location_id) {

      this.log.error("Unable to determine the lock location for the %s.", this.lockRelayDescription);

      return null;
    }

    return {

      ...this.uda,
      capabilities,
      ...(locationId && (locationId !== this.uda.location_id) ? {

        // eslint-disable-next-line camelcase
        location_id: locationId
      } : {})
    } as AccessDeviceConfig;
  }

  private scheduleDefaultLockReset(device: AccessDeviceConfig, attempt = 0, delay?: number): void {

    if(this.lockResetTimer) {

      clearTimeout(this.lockResetTimer);
      this.lockResetTimer = null;
    }

    const effectiveDelay = delay ?? (this.isG3Reader ? G3_READER_LOCK_RESET_DELAY : DEFAULT_LOCK_RESET_DELAY);

    this.lockResetTimer = setTimeout(() => {

      this.lockResetTimer = null;
      void this.resetLockToDefaultState(device, attempt);
    }, effectiveDelay);
  }

  private async resetLockToDefaultState(device: AccessDeviceConfig, attempt = 0): Promise<void> {

    if(this.isG3Reader) {

      if(this.g3ReaderLockStateOverride !== this.hap.Characteristic.LockCurrentState.SECURED) {

        this.g3ReaderLockStateOverride = this.hap.Characteristic.LockCurrentState.SECURED;
      }

      if(this.hkLockState !== this.hap.Characteristic.LockCurrentState.SECURED) {

        this.hkLockState = this.hap.Characteristic.LockCurrentState.SECURED;
      }

      return;
    }

    try {

      if(!this.isOnline) {

        const nextAttempt = attempt + 1;

        if(nextAttempt < LOCK_RESET_MAX_ATTEMPTS) {

          this.log.debug("Retrying lock reset while offline (attempt %s of %s).", nextAttempt + 1, LOCK_RESET_MAX_ATTEMPTS);
          this.scheduleDefaultLockReset(device, nextAttempt, LOCK_RESET_RETRY_DELAY);
        } else {

          this.log.error("Unable to reset the %s to a locked state after unlocking.", this.lockRelayDescription);
        }

        return;
      }

      let commandSucceeded: boolean;

      if(this.isG3Reader) {

        commandSucceeded = await this.lockG3Reader(device);
      } else {

        commandSucceeded = await this.controller.udaApi.unlock(device, 0);
      }

      if(!commandSucceeded) {

        const nextAttempt = attempt + 1;

        if(nextAttempt < LOCK_RESET_MAX_ATTEMPTS) {

          this.log.debug("Retrying lock reset after failure (attempt %s of %s).", nextAttempt + 1, LOCK_RESET_MAX_ATTEMPTS);
          this.scheduleDefaultLockReset(device, nextAttempt, LOCK_RESET_RETRY_DELAY);
        } else {

          this.log.error("Unable to reset the %s to a locked state after unlocking.", this.lockRelayDescription);
        }

        return;
      }

      if(this.hkLockState !== this.hap.Characteristic.LockCurrentState.SECURED) {

        this.hkLockState = this.hap.Characteristic.LockCurrentState.SECURED;
      }
    } catch(error) {

      const nextAttempt = attempt + 1;

      if(nextAttempt < LOCK_RESET_MAX_ATTEMPTS) {

        this.log.debug("Retrying lock reset after error (attempt %s of %s): %s.", nextAttempt + 1, LOCK_RESET_MAX_ATTEMPTS, error);
        this.scheduleDefaultLockReset(device, nextAttempt, LOCK_RESET_RETRY_DELAY);

        return;
      }

      this.log.error("Unable to reset the %s to a locked state after unlocking: %s.", this.lockRelayDescription, error);
    }
  }

  private async lockG3Reader(device: AccessDeviceConfig): Promise<boolean> {

    const locationId = device.location_id ?? this.uda.location_id ?? this.uda.door?.unique_id;

    if(!locationId) {

      this.log.error("Unable to determine the lock location for the %s.", this.lockRelayDescription);

      return false;
    }

    const endpoint = this.controller.udaApi.getApiEndpoint("location");

    if(!endpoint?.length) {

      this.log.error("Unable to determine the lock endpoint for the %s.", this.lockRelayDescription);

      return false;
    }

    const response = await this.controller.udaApi.retrieve(endpoint + "/" + locationId + "/lock", { method: "PUT" });

    if(!response) {

      return false;
    }

    try {

      const status = await response.json() as { codeS?: string };

      if(status?.codeS === "SUCCESS") {

        return true;
      }

      this.log.error("Error locking the %s: \n%s", this.lockRelayDescription,
        util.inspect(status, { colors: false, depth: null, sorted: true }));
    } catch(error) {

      this.log.error("Unable to parse the lock response for the %s: %s.", this.lockRelayDescription, error);
    }

    return false;
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

  private getDryContactDefinition(sensorType: DryContactSensorType): DryContactSensorDefinition {

    return DRY_CONTACT_SENSOR_DEFINITIONS[sensorType];
  }

  private getDryContactDisplayName(sensorType: DryContactSensorType): string {

    return this.accessoryName + this.getDryContactDefinition(sensorType).displayNameSuffix;
  }

  private getDryContactHint(sensorType: DryContactSensorType, hintType: "has" | "log"): boolean {

    switch(sensorType) {

      case "rel":

        return hintType === "has" ? this.hints.hasRel : this.hints.logRel;

      case "ren":

        return hintType === "has" ? this.hints.hasRen : this.hints.logRen;

      case "rex":

        return hintType === "has" ? this.hints.hasRex : this.hints.logRex;

      default:

        return false;
    }
  }

  private getDryContactState(sensorType: DryContactSensorType): CharacteristicValue {

    if(!this.isDryContactWired(sensorType)) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    const key = this.getDryContactStateKey(sensorType);

    if(!key) {

      return this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    }

    const value = this.uda.configs?.find(x => x.key === key)?.value;
    const normalizedValue = typeof value === "string" ? value.toLowerCase() : "";

    switch(normalizedValue) {

      case "1":
      case "active":
      case "closed":
      case "on":
      case "true":

        return this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;

      case "0":
      case "inactive":
      case "open":
      case "off":
      case "false":

        return this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;

      default:

        return this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    }
  }

  private getDryContactStateKey(sensorType: DryContactSensorType): string | null {

    const definition = this.getDryContactDefinition(sensorType);

    if(this.isMiniVariant && definition.stateKeys.mini) {

      return definition.stateKeys.mini;
    }

    return definition.stateKeys.default ?? null;
  }

  private getDryContactWiringKeys(sensorType: DryContactSensorType): string[] {

    const definition = this.getDryContactDefinition(sensorType);

    if(this.isMiniVariant && definition.wiringKeys.mini) {

      return definition.wiringKeys.mini;
    }

    return definition.wiringKeys.default ?? [];
  }

  private isDryContactWired(sensorType: DryContactSensorType): boolean {

    if(this.isMiniVariant && (sensorType === "rel")) {

      return true;
    }

    const wiringKeys = this.getDryContactWiringKeys(sensorType);

    if(!wiringKeys.length) {

      return false;
    }

    return wiringKeys.filter(wire => this.uda.configs?.some(x => x.key === wire && x.value === "on")).length === wiringKeys.length;
  }

  private hasDryContactSensor(sensorType: DryContactSensorType): boolean {

    if(!this.hasFeature(this.featurePrefix + "." + sensorType.toUpperCase())) {

      return false;
    }

    return this.hasDryContactHardware(sensorType);
  }

  private hasDryContactHardware(sensorType: DryContactSensorType): boolean {

    const key = this.getDryContactStateKey(sensorType);

    return key ? (this.uda.configs?.some(config => config.key === key) ?? false) : false;
  }

  private handleDryContactStateChange(sensorType: DryContactSensorType, newState: CharacteristicValue): void {

    if(!this.getDryContactHint(sensorType, "has")) {

      return;
    }

    if(this.dryContactStates[sensorType] === newState) {

      return;
    }

    this.dryContactStates[sensorType] = newState;

    const service = this.accessory.getServiceById(this.hap.Service.ContactSensor,
      this.getDryContactDefinition(sensorType).reservedName);

    service?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, newState);
    service?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline && this.isDryContactWired(sensorType));

    this.publishDryContactState(sensorType, newState);
  }

  private publishDryContactState(sensorType: DryContactSensorType, newState: CharacteristicValue): void {

    if(!this.isDryContactWired(sensorType)) {

      return;
    }

    const payload = (newState === this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED) ? "false" : "true";

    this.controller.mqtt?.publish(this.id, sensorType, payload);

    if(this.getDryContactHint(sensorType, "log")) {

      const definition = this.getDryContactDefinition(sensorType);
      const stateLabel = newState === this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED ? "closed" : "open";

      this.log.info("%s %s.", definition.logLabel, stateLabel);
    }
  }

  // Return the current state of the relay lock on the hub.
  private get hubLockState(): CharacteristicValue {

    if(this.isG3Reader && (this.g3ReaderLockStateOverride !== null)) {

      return this.g3ReaderLockStateOverride;
    }

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

  private get isMiniVariant(): boolean {

    const deviceType = this.uda.device_type ?? "";

    return deviceType === "UA-Hub-Door-Mini" || deviceType === "UA-ULTRA";
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

  private isG3ReaderAccessGrantEvent(packet: AccessEventPacket): boolean {

    if(!this.isG3Reader) {

      return false;
    }

    switch(packet.event.toLowerCase()) {

      case "access.data.device.access_granted":

        return packet.event_object_id === this.uda.unique_id;

      case "access.data.location.access_granted":

        // If we have a location identifier, validate that it matches the event object identifier. Otherwise, fall back to the
        // associated door identifier for the reader and validate that instead.
        return ((this.uda.location_id && (packet.event_object_id === this.uda.location_id)) ||
          (!!this.uda.door?.unique_id && (packet.event_object_id === this.uda.door.unique_id)));

      default:

        return false;
    }
  }

  private handleUnlockEvent(): void {

    if(this.isG3Reader) {

      this.g3ReaderLockStateOverride = null;
    }

    this.hkLockState = this.hap.Characteristic.LockCurrentState.UNSECURED;

    if(this.lockDelayInterval === undefined) {

      const device = this.getCommandDeviceConfig();

      if(device) {

        this.scheduleDefaultLockReset(device);
      }
    }

    this.controller.mqtt?.publish(this.id, "lock", "false");

    if(this.hints.logLock) {

      this.log.info("Unlocked.");
    }
  }

  // Handle hub-related events.
  private eventHandler(packet: AccessEventPacket): void {

    switch(packet.event) {

      case "access.data.device.remote_unlock":
      case "access.data.location.remote_unlock":

        this.handleUnlockEvent();

        break;
      case "access.data.device.access_granted":
      case "access.data.location.access_granted":

        if(!this.isG3ReaderAccessGrantEvent(packet)) {

          break;
        }

        this.handleUnlockEvent();

        break;

      case "access.data.device.update": {

        // Process a lock update event if our state has changed.
        if(this.isG3Reader) {

          this.g3ReaderLockStateOverride = null;
        }

        const updatedLockState = this.hubLockState;

        if(updatedLockState !== this.hkLockState) {

          this.hkLockState = updatedLockState;

          if(this.hkLockState === this.hap.Characteristic.LockCurrentState.SECURED) {

            if(this.lockResetTimer) {

              clearTimeout(this.lockResetTimer);
              this.lockResetTimer = null;
            }
          } else if(this.lockDelayInterval === undefined) {

            const device = this.getCommandDeviceConfig();

            if(device) {

              this.scheduleDefaultLockReset(device);
            }
          }

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

        for(const sensorType of DRY_CONTACT_SENSOR_TYPES) {

          if(!this.getDryContactHint(sensorType, "has")) {

            continue;
          }

          this.handleDryContactStateChange(sensorType, this.getDryContactState(sensorType));
        }

        this.refreshAccessMethodSwitches();

        break;
      }

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
