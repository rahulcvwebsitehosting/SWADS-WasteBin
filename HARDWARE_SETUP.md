# SWADS Prototype Hardware Setup

This wiring matches the parts in `Materials Required.pdf` and firmware in
`firmware/swads_esp32/swads_esp32.ino`.

## Required electrical connections

| Component | Connection |
| --- | --- |
| ESP32 DevKit V1 | Power through `VIN` from the regulated MT3608 5 V output; all grounds must be common. |
| HC-SR04 | `VCC` to regulated 5 V, `GND` to common ground, `TRIG` to GPIO5, divided `ECHO` to GPIO18. |
| Echo divider | HC-SR04 `ECHO` -> 1 kOhm -> GPIO18 junction -> 2 kOhm -> GND. Do not connect Echo directly to the ESP32. |
| Red LED | GPIO2 -> 220 Ohm -> LED anode; LED cathode -> GND. |
| Active buzzer module | Module `SIG/IN` to GPIO4, `GND` to common ground, and `VCC` to the voltage printed on the module. Use a three-pin module with a logic input. |
| Battery chain | Protected TP4056 `OUT+/-` -> MT3608 `IN+/-`; adjust MT3608 to exactly 5.0 V before connecting ESP32 `VIN`. |

## Power safety

1. Verify MT3608 output is 5.0 V with the multimeter before connecting the ESP32 or HC-SR04.
2. Use a TP4056 board with battery-protection circuitry and separate `B+/-` and `OUT+/-` pads.
3. A basic TP4056 board has no power-path/load-sharing controller. For this exact prototype parts list, switch the ESP32 load off while charging the 18650 cell.
4. Do not power ESP32 USB and `VIN` from MT3608 at the same time unless the custom PCB explicitly isolates the two 5 V sources.
5. Use the 5 V, 2 A adapter and Micro-USB cable for bench programming, or as the TP4056 charging input, not as a second simultaneous ESP32 supply.
6. Observe 18650 polarity. Insulate solder joints with heat-shrink or tape and secure the battery against shorts.

## Assembly and calibration

1. Prototype on the MB102 breadboard and jumper wires before transferring the same nets to the custom PCB.
2. Mount the HC-SR04 at the top, facing the bin bottom without wall obstructions.
3. Register the bin in the Android app with the empty sensor-to-bottom distance as `heightCm`.
4. For the default firmware IDs, register `bin-001`; this maps to device ID `esp32-bin-001`.
5. Copy `firebase_secrets.example.h` to ignored `firebase_secrets.h` and enter Wi-Fi and device credentials.
6. If the buzzer is active-low, set `BUZZER_ACTIVE_HIGH` to `0` in `firebase_secrets.h`.

## Expected behavior

- Five HC-SR04 readings are median-filtered every five seconds.
- Three consecutive windows at or above 80% set the LED, pulse the buzzer, and queue `ALERT_80`.
- Three consecutive windows at or below 20% clear the indicators and queue `RESET`.
- Telemetry is written under `/swads/v1/devices/{deviceId}` and Cloud Functions mirror live fill/state to `/swads/v1/bins/{binId}`.
- The optional SIM800L is not used by this Wi-Fi/Firebase firmware and should remain disconnected. A SIM800L requires its own high-current supply and separate firmware support.

## Tools and construction items

The multimeter, soldering kit, hot glue or tape, headers, heat-shrink, cable ties,
screws, connectors, and extra wires are assembly/test tools rather than software-
addressable components. Use hot glue only after electrical testing and keep it off
the TP4056, MT3608 adjustment screw, ESP32 antenna, and HC-SR04 transducers.
