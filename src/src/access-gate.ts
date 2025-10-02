/* Copyright(C) 2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-gate.ts: Gate hub device class for UniFi Access.
 */
import { AccessHub } from "./access-hub.js";

export class AccessGate extends AccessHub {

  constructor(...args: ConstructorParameters<typeof AccessHub>) {

    super(...args);

    this.log.info("Configured UniFi Access Gate Hub accessory.");
  }

  protected override get featurePrefix(): string {

    return "Gate";
  }

  protected override get lockRelayDescription(): string {

    return "gate lock relay";
  }

  protected override get positionSensorDisplayName(): string {

    return this.accessoryName + " Gate Position Sensor";
  }

  protected override get positionSensorLogLabel(): string {

    return "Gate position sensor";
  }

  protected override get mqttDpsLabel(): string {

    return "Gate position sensor";
  }
}
