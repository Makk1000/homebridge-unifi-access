/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-types.ts: Interface and type definitions for UniFi Access.
 */

// HBUA reserved names.
export enum AccessReservedNames {

  // Manage our contact sensor types.
  CONTACT_DPS = "ContactSensor.DPS",

  // Manage our switch types.
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_LOCK_TRIGGER = "LockTrigger",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger"
}

// Known UniFi Access device class prefixes for G3 Reader models. The controller may
// report these readers either as "UA-G3-Reader" or with the shorter "UA G3 B" label,
// so we normalize both representations here.
export const G3_READER_CLASS_PREFIXES = [ "UAG3READER", "UAG3B" ];

// Determine whether a normalized device class represents a G3 Reader variant.
export const isG3ReaderDeviceClass = (normalizedDeviceClass: string): boolean => G3_READER_CLASS_PREFIXES.some((prefix) => normalizedDeviceClass.startsWith(prefix));
