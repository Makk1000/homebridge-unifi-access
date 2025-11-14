/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-types.ts: Interface and type definitions for UniFi Access.
 */

// HBUA reserved names.
export enum AccessReservedNames {

  // Manage our contact sensor types.
  CONTACT_DPS = "ContactSensor.DPS",
  CONTACT_REL = "ContactSensor.REL",
  CONTACT_REN = "ContactSensor.REN",
  CONTACT_REX = "ContactSensor.REX",

  // Manage our switch types.
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_LOCK_TRIGGER = "LockTrigger",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger"
}

// Known UniFi Access device class representations for G3 Reader models. Some
// controller builds advertise the reader with the generic "UA G3" type while
// others include a "Reader" or "G3 B" suffix. We normalize all of them here.
const G3_READER_CLASS_PREFIXES = [ "UAG3READER", "UAG3B" ];
const G3_READER_CLASS_EXACT_MATCHES = [ "UAG3" ];

// Determine whether a normalized device class represents a G3 Reader variant.
export const isG3ReaderDeviceClass = (normalizedDeviceClass: string): boolean => (
  G3_READER_CLASS_EXACT_MATCHES.includes(normalizedDeviceClass) ||
  G3_READER_CLASS_PREFIXES.some((prefix) => normalizedDeviceClass.startsWith(prefix))
);
