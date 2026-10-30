# WebGL renderer repair

Replaced Canvas face sorting with locally bundled Three.js r160 (MIT), using a hardware depth buffer, lit materials, visible-surface raycasting and depth-tested wires. Meshes are batched by component using vertex colors; disposed on rebuild. Orbit and selection do not rebuild geometry. Added pointer cancellation and graphics-context recovery handling. Vendor code and license are stored locally; deployed rendering makes no third-party CDN request.

Fixed stale confirmation counters after Restore wiring, demo timer carryover, calibration edits being overwritten by an active demo, stale inspection camera after switching views, and missing favicon. Added a component inspection camera.

Validation: 36 Node checks (12 state rules; 24 geometry combinations with 15 orbit poses each), plus browser checks of 18 viewport/view/cutaway/wiring combinations, repeated view switching, component inspection and demo completion. No script errors, empty scenes or horizontal overflow observed in those browser combinations. Checks do not prove operation on every GPU/browser.

Product references inspected 30 October 2026:

- https://robu.in/product/tp4056-1a-li-ion-lithium-battery-charging-module-with-current-protection-mini-usb/ — SKU 53264: Mini-USB, TP4056 / DW01, B and OUT connections. Robu explicitly says product design may differ. Model connector opening, protection chip and pads revised.
- https://robu.in/product/smartelex-esp32-wroom-32e-development-kit-1-pcs/ — R150542: PCB antenna, development kit and two male headers. Listing does not establish delivered pin count or board dimensions. Header geometry remains illustrative.
- Purchase photograph: silver dual-can sensor, pink 18650, green perfboard and white MB102 breadboard visible. Hidden anti-static packages cannot establish exact board geometry.
- Robu searches for R261487 and 261487 returned no product. Boost model remains unverified.

Sensor grille and antenna detail improved. Enclosure and bin are original design concepts, not purchased product replicas. No measured-fit claim is made. Cloud/notification behavior remains simulated.
