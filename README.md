# SWADS — Smart Waste Alert and Dispatch System

ESP32/HC-SR04 fill sensing, local LED/buzzer alerts, an Android dashboard, and
Firebase collection-request email coordination. A request email is not proof that
a collection team accepted or completed the job.

## Software 1.1

- Local sensing runs in an independent FreeRTOS task; Firebase timeouts cannot
  stop the sensor loop. A bounded history queue drops old records on overflow
  while preserving current local alert behaviour.
- Confirmed alert and reset events survive restarts. Latest device state uploads
  before offline history, so old alerts can be identified as superseded.
- Cleared cycles cannot be reopened by delayed alerts or Gmail completions.
- Definite dispatch failures get up to five attempts with exponential backoff.
  Ambiguous Gmail outcomes require checking Sent mail before an explicit retry.
- Automatic email uses only owner-verified contacts saved for the individual bin.
  AI suggestions are advisory; there are no automatic regional fallback emails.
- Registration and calibration use authenticated backend calls. Clients cannot
  write device ownership or live readings directly.
- Android supports bin/contact settings, retry controls, stale-reading indicators,
  token refresh and account-filtered foreground/background notifications.

## Initial setup

1. Install Node 22, Java 21 or newer for the Firebase emulator, Android Studio,
   and PlatformIO. Run `npm ci` in `functions`.
2. Configure Firebase Authentication (Google and device Email/Password), the
   Realtime Database, Gmail API, and the matching Android OAuth certificate.
3. Store `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in Firebase
   Secret Manager. `OPENROUTER_API_KEY` is only for the optional contact-suggestion
   callable. No secret is required for compilation or regression tests.
4. With administrator Application Default Credentials, run
   `npm run provision -- bin-001` from `functions`. This creates the dedicated
   device user, registry reservation and `deviceUsers` authorization. Credentials
   and a one-time claim code go into ignored `functions/.secrets/`.
5. Copy `firebase_secrets.example.h` to ignored `firebase_secrets.h` and enter
   Wi-Fi/device credentials. Use the provisioned device/bin IDs in
   `firebase_config.h`. A 2.4 GHz Wi-Fi network is needed.
6. Deploy the updated functions and database rules together, build the updated
   Android application, and flash firmware 1.1.0. Existing device mappings must
   include the correct `ownerUid`, `binId`, and device Authentication UID mapping.
7. Sign in, register the bin using its claim code, and enter the empty
   sensor-to-bottom distance. First-use local alerts wait for valid calibration;
   persisted calibration supports later offline operation.
8. Enter an independently verified collection email, organization, and HTTPS
   source page in bin settings. Monitoring remains available without a contact.

The provisioning script intentionally refuses to replace an existing device.
For an existing installation, an administrator should preserve its Firebase UID
and credentials and inspect its registry/mapping rather than reprovision blindly.

## Verification

```sh
cd functions
npm test
npm run test:rules
cd ..
pio run -d firmware
cd android
./gradlew :app:assembleDebug
```

`npm test` runs isolated orchestration tests with simulated mail delivery, never
real emails. Rules tests require a working local database emulator. The GitHub
workflow runs backend/rules tests, compiles the firmware and builds an Android
debug APK without deploying or flashing anything.

Before using real collection recipients, verify a full physical cycle using a
test inbox: stable empty reading, 80% confirmation, email/notification, reset,
network loss/reconnect, sensor timeout, and device restart. Battery runtime and
enclosure sealing still require physical measurement/inspection.

## Hardware

See [HARDWARE_SETUP.md](HARDWARE_SETUP.md). This matches the finalized purchased
20 kΩ divider resistors, 330 Ω LED resistor, protected TP4056 and 5 V boost module.
Exact module terminal orientation must be checked against the delivered boards.
