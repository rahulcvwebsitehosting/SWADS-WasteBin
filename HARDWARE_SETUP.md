# SWADS Prototype Hardware Setup

This wiring matches the finalized Robu purchases and firmware in
`firmware/swads_esp32/swads_firmware.cpp` (with an Arduino `.ino` entry file).

## Required electrical connections

| Component | Connection |
| --- | --- |
| SmartElex ESP32-WROOM-32E | Power through `VIN` from the verified regulated 5 V boost output (R261487); all grounds must be common. |
| HC-SR04 | `VCC` to regulated 5 V, `GND` to common ground, `TRIG` to GPIO5, divided `ECHO` to GPIO18. |
| Echo divider | HC-SR04 `ECHO` -> 20 kOhm -> GPIO18 junction -> two 20 kOhm resistors in series -> GND. Do not connect Echo directly to the ESP32. |
| Red LED | GPIO2 -> 330 Ohm -> LED anode; LED cathode -> GND. |
| Active buzzer module | Module `SIG/IN` to GPIO4, `GND` to common ground, and `VCC` to the voltage printed on the module. Use a three-pin module with a logic input. |
| Battery chain | Protected TP4056 `OUT+/-` -> 5 V boost module `IN+/-`; verify the boost output is 5.0 V before connecting ESP32 `VIN`. |

## Power safety

1. Verify the boost output is 5.0 V with the multimeter before connecting the ESP32 or HC-SR04.
2. Use the protected TP4056 (SKU 53264) with separate `B+/-` and `OUT+/-` pads. Keep the unprotected Type-C charger as a spare; do not connect both chargers to one cell. Put the load switch between protected `OUT+` and boost `IN+`.
3. A basic TP4056 board has no power-path/load-sharing controller. For this exact prototype parts list, switch the ESP32 load off while charging the 18650 cell.
4. Do not power ESP32 USB and `VIN` from 5 V boost module at the same time unless the custom PCB explicitly isolates the two 5 V sources.
5. Use the 5 V, 2 A adapter and Micro-USB cable for bench programming, or as the TP4056 charging input, not as a second simultaneous ESP32 supply.
6. Observe 18650 polarity. Insulate solder joints with heat-shrink or tape and secure the battery against shorts.
7. Common ground means the protected load-side `OUT-` for ESP32, boost output, sensor and buzzer. The battery negative connects to `B-` only. Do not bridge `B-` and `OUT-`, which can bypass the protection board's switching path.

## Assembly and calibration

1. Prototype on the MB102 breadboard and jumper wires before transferring the same nets to the custom PCB.
2. Mount the HC-SR04 at the top, facing the bin bottom without wall obstructions.
3. Provision the device using the administrator script documented in README.md, then register it using its claim code in the Android app with the empty sensor-to-bottom distance as `heightCm`.
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
the TP4056, 5 V boost module adjustment screw, ESP32 antenna, and HC-SR04 transducers.

## Finalized-part notes

- The Echo divider uses three purchased 20 kΩ resistors: one above the GPIO18 junction and two in series below it. Nominal output is 3.33 V from a 5 V Echo signal. Never connect Echo directly to GPIO18.
- Use one purchased 330 Ω resistor with the external alert LED. The second LED is spare.
- The code controls the active buzzer through its logic input. Confirm the supplied board pin labels, required VCC, and active-high/low behaviour before wiring.
- Connect the ESP32 only through its documented regulated 5 V input or USB. Never apply boosted 5 V to its 3V3 pin. Keep USB and external 5 V supplies separate unless the board schematic confirms isolation.
- Fit the 18650 in its holder, observe capacitor polarity, and verify the regulated output with a multimeter before connecting electronics. The 1000 µF capacitors are bulk decoupling, not battery protection.
- A Micro-USB cable does not fit a Mini-USB charger socket. Confirm the actual charger connector.
- The breadboard kit is for bench assembly; use the prototype board for the final mounted circuit. Keep the ESP32 antenna clear of wiring and metal.
- The enclosure rating applies to the unmodified box. Sensor holes, switches and cable entries require suitable sealing; the HC-SR04 itself is not a weatherproof probe.
- Sensing continues without Wi-Fi. On first use, alerts wait for registered calibration. The 12-event queue drops the oldest history on overflow and reports that history was lost, while current LED/buzzer state continues normally.
- Before sending real requests, save an independently verified contact for this bin and test with an inbox you control. AI suggestions are not automatically trusted or emailed.
