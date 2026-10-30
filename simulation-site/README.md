# SWADS Virtual Prototype Lab

Double-click `SWADS_3D_Lab.html` for the self-contained offline lab. No installation, internet or server required. Rebuild it after edits with `node bundle.mjs`.

Alternatively run `npm start`, then open http://127.0.0.1:4173. No dependencies required. Run `npm test` for the local state-model checks.

The `dist/` folder is the standalone static website. It uses locally bundled Three.js r160 (MIT) with a WebGL depth buffer, lit meshes, orbit, zoom and visible-surface picking. WebGL-capable browser required. No external runtime requests are needed. Geometry is illustrative, not measured CAD.

Views: assembled cutaway, exploded concept, circuit explorer. Controls: fill, depth, power, Wi-Fi, calibration, sensor timeout, contact verification, pause, step and speed. Connection bench injects open-circuit faults. The working demo demonstrates fill alert, offline reset and reconnect without contacting Firebase or sending mail.

Model basis: parent repository `HARDWARE_SETUP.md`, `firmware/swads_esp32/swads_firmware.cpp` and delivered `Components.jpeg`. The 80/20 thresholds, three-window confirmation, 5-second windows, 2–400 cm validity range and bounded 12-event offline queue mirror selected firmware rules. This JavaScript model does not execute the actual ESP32 firmware. Each modeled valid window represents ideal identical readings; it does not inject raw sample noise or prove the actual median implementation. Physical power, RF, acoustics, thermal, battery, weather sealing and tolerance checks are excluded. Cloud behavior and dispatch are explanatory abstractions, not backend integration tests. Disconnected LED/buzzer wiring affects modeled outputs but cannot be detected by real firmware without extra feedback hardware.

Existing firmware and application files have not been modified by this preview. Spare SIM800L and unprotected Type-C charger are shown disconnected.
