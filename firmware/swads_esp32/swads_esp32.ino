#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <Preferences.h>
#include <math.h>
#include <string.h>

#include <addons/TokenHelper.h>

#include "firebase_config.h"

namespace {

constexpr uint8_t TRIGGER_PIN = 5;
constexpr uint8_t ECHO_PIN = 18;
constexpr uint8_t LED_PIN = 2;
constexpr uint8_t BUZZER_PIN = 4;

// HC-SR04 wiring:
//   VCC  -> MT3608 regulated 5 V output
//   GND  -> common ground shared with the ESP32
//   TRIG -> GPIO5
//   ECHO -> 10 kOhm resistor -> GPIO18 -> 20 kOhm resistor -> GND
//
// The divider limits the HC-SR04's 5 V Echo output to:
//   5.0 V * 20 kOhm / (10 kOhm + 20 kOhm) = 3.33 V
// The divider changes voltage only; pulse duration is read normally by pulseIn().
constexpr uint32_t ECHO_DIVIDER_TOP_OHMS = 10000;
constexpr uint32_t ECHO_DIVIDER_BOTTOM_OHMS = 20000;
constexpr float ECHO_DIVIDER_MAX_OUTPUT_VOLTS = 3.33f;

constexpr uint8_t MEDIAN_SAMPLE_COUNT = 5;
constexpr uint8_t MINIMUM_VALID_SAMPLES = 3;
constexpr uint8_t STATE_CONFIRMATION_WINDOWS = 3;
constexpr uint32_t ECHO_TIMEOUT_MICROSECONDS = 30000;
constexpr uint32_t INTER_SAMPLE_DELAY_MS = 60;
constexpr float SPEED_OF_SOUND_CM_PER_MICROSECOND = 0.0343f;
constexpr float MINIMUM_SENSOR_DISTANCE_CM = 2.0f;
constexpr float MAXIMUM_SENSOR_DISTANCE_CM = 400.0f;

constexpr float ALERT_TRIGGER_FILL_PERCENT = 80.0f;
constexpr float RESET_FILL_PERCENT = 20.0f;
constexpr float MINIMUM_BIN_HEIGHT_CM = 10.0f;
constexpr float MAXIMUM_BIN_HEIGHT_CM = 350.0f;

constexpr uint32_t SENSOR_INTERVAL_MS = 5000;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 60000;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 30UL * 60UL * 1000UL;
constexpr uint32_t CONFIG_REFRESH_INTERVAL_MS = 5UL * 60UL * 1000UL;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 15000;
constexpr uint32_t EVENT_RETRY_INTERVAL_MS = 5000;
constexpr uint32_t CLOUD_WRITE_RETRY_INTERVAL_MS = 5000;
constexpr uint32_t BUZZER_ON_MS = 400;
constexpr uint32_t BUZZER_OFF_MS = 1600;

constexpr uint16_t CONTRACT_SCHEMA_VERSION = 1;
constexpr uint32_t PERSISTENCE_MAGIC = 0x53574144;
constexpr uint16_t PERSISTENCE_VERSION = 1;
constexpr size_t EVENT_ID_CAPACITY = 96;
constexpr uint8_t MAX_PENDING_EVENTS = 12;

enum class BinState : uint8_t {
  NORMAL = 0,
  CRITICAL = 1
};

enum class EventType : uint8_t {
  NONE = 0,
  ALERT_80 = 1,
  RESET = 2
};

struct Measurement {
  bool valid = false;
  float distanceCm = NAN;
  float fillPercent = NAN;
  uint8_t validSampleCount = 0;
  uint8_t timeoutSampleCount = 0;
  uint8_t outOfRangeSampleCount = 0;
  uint32_t measuredAtUptimeMs = 0;
};

struct PendingEvent {
  uint8_t type = static_cast<uint8_t>(EventType::NONE);
  uint8_t measurementValid = 0;
  uint8_t validSampleCount = 0;
  uint8_t timeoutSampleCount = 0;
  uint8_t outOfRangeSampleCount = 0;
  uint32_t sequence = 0;
  uint32_t bootCount = 0;
  uint32_t detectedAtUptimeMs = 0;
  uint32_t calibrationVersion = 0;
  float distanceCm = NAN;
  float fillPercent = NAN;
  float binHeightCm = DEFAULT_BIN_HEIGHT_CM;
  char eventId[EVENT_ID_CAPACITY] = {};
  char alertCycleId[EVENT_ID_CAPACITY] = {};
};

struct PersistedRuntime {
  uint32_t magic = PERSISTENCE_MAGIC;
  uint16_t version = PERSISTENCE_VERSION;
  uint8_t binState = static_cast<uint8_t>(BinState::NORMAL);
  uint8_t pendingEventCount = 0;
  uint8_t eventQueueOverflow = 0;
  uint8_t reserved = 0;
  uint32_t bootCount = 0;
  uint32_t eventSequence = 0;
  uint32_t calibrationVersion = 0;
  float binHeightCm = DEFAULT_BIN_HEIGHT_CM;
  char activeAlertCycleId[EVENT_ID_CAPACITY] = {};
  PendingEvent pendingEvents[MAX_PENDING_EVENTS] = {};
};

FirebaseData firebaseData;
FirebaseAuth firebaseAuth;
FirebaseConfig firebaseConfig;
Preferences preferences;

PersistedRuntime persistedRuntime;
Measurement latestMeasurement;

String deviceBasePath;
String deviceInfoPath;
String deviceConfigPath;
String deviceStatePath;
String deviceHeartbeatPath;
String deviceTelemetryPath;
String eventRootPath;
String bootId;

uint32_t telemetrySequence = 0;
uint8_t triggerConfirmationCount = 0;
uint8_t resetConfirmationCount = 0;
uint32_t consecutiveInvalidWindows = 0;

uint32_t lastSensorAt = 0;
uint32_t lastTelemetryAt = 0;
uint32_t lastTelemetryAttemptAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastHeartbeatAttemptAt = 0;
uint32_t lastConfigRefreshAt = 0;
uint32_t lastWifiReconnectAt = 0;
uint32_t lastEventAttemptAt = 0;
uint32_t lastInfoAttemptAt = 0;
uint32_t lastForcedSyncAttemptAt = 0;
uint32_t buzzerChangedAt = 0;

bool hasMeasurement = false;
bool firebaseInfoPublished = false;
bool forceStatePublish = true;
bool buzzerOutputHigh = false;

float roundToTwoDecimals(float value) {
  return roundf(value * 100.0f) / 100.0f;
}

bool intervalElapsed(uint32_t now, uint32_t previous, uint32_t interval) {
  return previous == 0 || static_cast<uint32_t>(now - previous) >= interval;
}

void copyText(char *destination, size_t capacity, const char *source) {
  if (capacity == 0) {
    return;
  }

  if (source == nullptr) {
    destination[0] = '\0';
    return;
  }

  snprintf(destination, capacity, "%s", source);
}

bool isValidFirebaseKey(const char *value) {
  if (value == nullptr || value[0] == '\0') {
    return false;
  }

  for (const char *cursor = value; *cursor != '\0'; ++cursor) {
    const unsigned char character = static_cast<unsigned char>(*cursor);
    if (character <= 0x1F || character == 0x7F ||
        character == '.' || character == '$' || character == '#' ||
        character == '[' || character == ']' || character == '/') {
      return false;
    }
  }

  return true;
}

const char *binStateName(BinState state) {
  return state == BinState::CRITICAL ? "CRITICAL" : "NORMAL";
}

const char *eventTypeName(EventType type) {
  switch (type) {
    case EventType::ALERT_80:
      return "ALERT_80";
    case EventType::RESET:
      return "RESET";
    default:
      return "NONE";
  }
}

const char *sensorHealthName(const Measurement &measurement) {
  if (!hasMeasurement) {
    return "INITIALIZING";
  }

  if (!measurement.valid) {
    return measurement.timeoutSampleCount >= MINIMUM_VALID_SAMPLES
        ? "TIMEOUT"
        : "INVALID";
  }

  return measurement.validSampleCount == MEDIAN_SAMPLE_COUNT
      ? "OK"
      : "DEGRADED";
}

BinState currentBinState() {
  return persistedRuntime.binState == static_cast<uint8_t>(BinState::CRITICAL)
      ? BinState::CRITICAL
      : BinState::NORMAL;
}

float triggerDistanceCm(float binHeightCm) {
  return binHeightCm * (1.0f - ALERT_TRIGGER_FILL_PERCENT / 100.0f);
}

float resetDistanceCm(float binHeightCm) {
  return binHeightCm * (1.0f - RESET_FILL_PERCENT / 100.0f);
}

float calculateFillPercent(float distanceCm, float binHeightCm) {
  if (binHeightCm <= 0.0f) {
    return 0.0f;
  }

  const float fillPercent = ((binHeightCm - distanceCm) / binHeightCm) * 100.0f;
  return constrain(fillPercent, 0.0f, 100.0f);
}

void initializePersistedRuntime() {
  memset(&persistedRuntime, 0, sizeof(persistedRuntime));
  persistedRuntime.magic = PERSISTENCE_MAGIC;
  persistedRuntime.version = PERSISTENCE_VERSION;
  persistedRuntime.binState = static_cast<uint8_t>(BinState::NORMAL);
  persistedRuntime.binHeightCm = DEFAULT_BIN_HEIGHT_CM;
}

void savePersistedRuntime() {
  const size_t bytesWritten = preferences.putBytes(
      "runtime",
      &persistedRuntime,
      sizeof(persistedRuntime));

  if (bytesWritten != sizeof(persistedRuntime)) {
    Serial.println("NVS write failed: persisted runtime is incomplete.");
  }
}

void loadPersistedRuntime() {
  const size_t storedLength = preferences.getBytesLength("runtime");
  if (storedLength != sizeof(persistedRuntime)) {
    initializePersistedRuntime();
    savePersistedRuntime();
    return;
  }

  preferences.getBytes("runtime", &persistedRuntime, sizeof(persistedRuntime));
  const bool invalidHeader =
      persistedRuntime.magic != PERSISTENCE_MAGIC ||
      persistedRuntime.version != PERSISTENCE_VERSION;
  const bool invalidState =
      persistedRuntime.binState > static_cast<uint8_t>(BinState::CRITICAL);
  const bool invalidQueue =
      persistedRuntime.pendingEventCount > MAX_PENDING_EVENTS;
  const bool invalidHeight =
      !isfinite(persistedRuntime.binHeightCm) ||
      persistedRuntime.binHeightCm < MINIMUM_BIN_HEIGHT_CM ||
      persistedRuntime.binHeightCm > MAXIMUM_BIN_HEIGHT_CM;

  if (invalidHeader || invalidState || invalidQueue || invalidHeight) {
    initializePersistedRuntime();
    savePersistedRuntime();
  }
}

void updateIndicators(uint32_t now) {
  if (currentBinState() != BinState::CRITICAL) {
    digitalWrite(LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOutputHigh = false;
    buzzerChangedAt = now;
    return;
  }

  digitalWrite(LED_PIN, HIGH);

  const uint32_t interval = buzzerOutputHigh ? BUZZER_ON_MS : BUZZER_OFF_MS;
  if (intervalElapsed(now, buzzerChangedAt, interval)) {
    buzzerOutputHigh = !buzzerOutputHigh;
    digitalWrite(BUZZER_PIN, buzzerOutputHigh ? HIGH : LOW);
    buzzerChangedAt = now;
  }
}

void sortAscending(float *values, uint8_t count) {
  for (uint8_t index = 1; index < count; ++index) {
    const float value = values[index];
    int8_t position = static_cast<int8_t>(index) - 1;

    while (position >= 0 && values[position] > value) {
      values[position + 1] = values[position];
      --position;
    }

    values[position + 1] = value;
  }
}

bool readDistanceSample(float &distanceCm, bool &timedOut) {
  digitalWrite(TRIGGER_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(TRIGGER_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIGGER_PIN, LOW);

  const unsigned long echoDuration = pulseIn(
      ECHO_PIN,
      HIGH,
      ECHO_TIMEOUT_MICROSECONDS);

  if (echoDuration == 0) {
    timedOut = true;
    return false;
  }

  timedOut = false;
  distanceCm =
      static_cast<float>(echoDuration) *
      SPEED_OF_SOUND_CM_PER_MICROSECOND /
      2.0f;

  return distanceCm >= MINIMUM_SENSOR_DISTANCE_CM &&
      distanceCm <= MAXIMUM_SENSOR_DISTANCE_CM;
}

Measurement readFilteredMeasurement() {
  Measurement measurement;
  float validDistances[MEDIAN_SAMPLE_COUNT] = {};

  for (uint8_t sampleIndex = 0;
       sampleIndex < MEDIAN_SAMPLE_COUNT;
       ++sampleIndex) {
    float distanceCm = NAN;
    bool timedOut = false;
    const bool valid = readDistanceSample(distanceCm, timedOut);

    if (valid) {
      validDistances[measurement.validSampleCount++] = distanceCm;
    } else if (timedOut) {
      ++measurement.timeoutSampleCount;
    } else {
      ++measurement.outOfRangeSampleCount;
    }

    if (sampleIndex + 1 < MEDIAN_SAMPLE_COUNT) {
      delay(INTER_SAMPLE_DELAY_MS);
    }
  }

  measurement.measuredAtUptimeMs = millis();
  if (measurement.validSampleCount < MINIMUM_VALID_SAMPLES) {
    return measurement;
  }

  sortAscending(validDistances, measurement.validSampleCount);
  const uint8_t middle = measurement.validSampleCount / 2;
  if (measurement.validSampleCount % 2 == 0) {
    measurement.distanceCm =
        (validDistances[middle - 1] + validDistances[middle]) / 2.0f;
  } else {
    measurement.distanceCm = validDistances[middle];
  }

  measurement.distanceCm = roundToTwoDecimals(measurement.distanceCm);
  measurement.fillPercent = roundToTwoDecimals(
      calculateFillPercent(
          measurement.distanceCm,
          persistedRuntime.binHeightCm));
  measurement.valid = true;
  return measurement;
}

void makeEventId(char *destination, size_t capacity, uint32_t sequence) {
  snprintf(
      destination,
      capacity,
      "%s-%lu-%lu",
      SWADS_DEVICE_ID,
      static_cast<unsigned long>(persistedRuntime.bootCount),
      static_cast<unsigned long>(sequence));
}

bool appendPendingEvent(EventType type, const Measurement &measurement) {
  if (persistedRuntime.pendingEventCount >= MAX_PENDING_EVENTS) {
    persistedRuntime.eventQueueOverflow = 1;
    return false;
  }

  ++persistedRuntime.eventSequence;

  PendingEvent &event =
      persistedRuntime.pendingEvents[persistedRuntime.pendingEventCount];
  memset(&event, 0, sizeof(event));

  event.type = static_cast<uint8_t>(type);
  event.measurementValid = measurement.valid ? 1 : 0;
  event.validSampleCount = measurement.validSampleCount;
  event.timeoutSampleCount = measurement.timeoutSampleCount;
  event.outOfRangeSampleCount = measurement.outOfRangeSampleCount;
  event.sequence = persistedRuntime.eventSequence;
  event.bootCount = persistedRuntime.bootCount;
  event.detectedAtUptimeMs = measurement.measuredAtUptimeMs;
  event.calibrationVersion = persistedRuntime.calibrationVersion;
  event.distanceCm = measurement.distanceCm;
  event.fillPercent = measurement.fillPercent;
  event.binHeightCm = persistedRuntime.binHeightCm;
  makeEventId(event.eventId, sizeof(event.eventId), event.sequence);

  if (type == EventType::ALERT_80) {
    copyText(
        event.alertCycleId,
        sizeof(event.alertCycleId),
        event.eventId);
    copyText(
        persistedRuntime.activeAlertCycleId,
        sizeof(persistedRuntime.activeAlertCycleId),
        event.eventId);
  } else {
    copyText(
        event.alertCycleId,
        sizeof(event.alertCycleId),
        persistedRuntime.activeAlertCycleId);
    persistedRuntime.activeAlertCycleId[0] = '\0';
  }

  ++persistedRuntime.pendingEventCount;
  return true;
}

void transitionTo(BinState newState, const Measurement &measurement) {
  if (newState == currentBinState()) {
    return;
  }

  const EventType eventType =
      newState == BinState::CRITICAL
      ? EventType::ALERT_80
      : EventType::RESET;

  const bool queued = appendPendingEvent(eventType, measurement);
  persistedRuntime.binState = static_cast<uint8_t>(newState);
  savePersistedRuntime();

  triggerConfirmationCount = 0;
  resetConfirmationCount = 0;
  forceStatePublish = true;

  Serial.printf(
      "State changed to %s; %s event queue.\n",
      binStateName(newState),
      queued ? "added to" : "could not add to");
}

void evaluateStateMachine(const Measurement &measurement) {
  if (!measurement.valid) {
    triggerConfirmationCount = 0;
    resetConfirmationCount = 0;
    ++consecutiveInvalidWindows;
    return;
  }

  consecutiveInvalidWindows = 0;

  if (currentBinState() == BinState::NORMAL) {
    resetConfirmationCount = 0;
    if (measurement.fillPercent >= ALERT_TRIGGER_FILL_PERCENT) {
      if (triggerConfirmationCount < STATE_CONFIRMATION_WINDOWS) {
        ++triggerConfirmationCount;
      }
    } else {
      triggerConfirmationCount = 0;
    }

    if (triggerConfirmationCount >= STATE_CONFIRMATION_WINDOWS) {
      transitionTo(BinState::CRITICAL, measurement);
    }
    return;
  }

  triggerConfirmationCount = 0;
  if (measurement.fillPercent <= RESET_FILL_PERCENT) {
    if (resetConfirmationCount < STATE_CONFIRMATION_WINDOWS) {
      ++resetConfirmationCount;
    }
  } else {
    resetConfirmationCount = 0;
  }

  if (resetConfirmationCount >= STATE_CONFIRMATION_WINDOWS) {
    transitionTo(BinState::NORMAL, measurement);
  }
}

void setNullableFloat(
    FirebaseJson &json,
    const String &path,
    bool hasValue,
    float value) {
  if (hasValue && isfinite(value)) {
    json.set(path, roundToTwoDecimals(value));
  } else {
    json.set(path);
  }
}

void addMeasurementJson(
    FirebaseJson &json,
    const String &prefix,
    const Measurement &measurement) {
  json.set(prefix + "/valid", measurement.valid);
  setNullableFloat(
      json,
      prefix + "/distanceCm",
      measurement.valid,
      measurement.distanceCm);
  setNullableFloat(
      json,
      prefix + "/fillPercent",
      measurement.valid,
      measurement.fillPercent);
  json.set(prefix + "/sampleCount", MEDIAN_SAMPLE_COUNT);
  json.set(
      prefix + "/validSampleCount",
      measurement.validSampleCount);
  json.set(
      prefix + "/timeoutSampleCount",
      measurement.timeoutSampleCount);
  json.set(
      prefix + "/outOfRangeSampleCount",
      measurement.outOfRangeSampleCount);
  json.set(prefix + "/sensorHealth", sensorHealthName(measurement));
  json.set(
      prefix + "/measuredAtDeviceUptimeMs",
      measurement.measuredAtUptimeMs);
}

void addThresholdJson(
    FirebaseJson &json,
    const String &prefix,
    float binHeightCm) {
  json.set(
      prefix + "/triggerFillPercent",
      ALERT_TRIGGER_FILL_PERCENT);
  json.set(prefix + "/resetFillPercent", RESET_FILL_PERCENT);
  json.set(
      prefix + "/triggerDistanceCm",
      roundToTwoDecimals(triggerDistanceCm(binHeightCm)));
  json.set(
      prefix + "/resetDistanceCm",
      roundToTwoDecimals(resetDistanceCm(binHeightCm)));
}

void maintainWifi(uint32_t now) {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (!intervalElapsed(now, lastWifiReconnectAt, WIFI_RECONNECT_INTERVAL_MS)) {
    return;
  }

  lastWifiReconnectAt = now;
  Serial.println("Wi-Fi disconnected; reconnecting.");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

bool publishDeviceInfo() {
  FirebaseJson json;
  json.set("schemaVersion", CONTRACT_SCHEMA_VERSION);
  json.set("deviceId", SWADS_DEVICE_ID);
  json.set("binId", SWADS_BIN_ID);
  json.set("bootId", bootId);
  json.set("bootCount", persistedRuntime.bootCount);
  json.set("firmwareVersion", SWADS_FIRMWARE_VERSION);
  json.set("firebaseUid", firebaseAuth.token.uid.c_str());
  json.set("hardware/microcontroller", "ESP32 DevKit V1");
  json.set("hardware/distanceSensor", "HC-SR04");
  json.set("hardware/power/charger", "TP4056");
  json.set("hardware/power/boostConverter", "MT3608");
  json.set("hardware/pins/triggerGpio", TRIGGER_PIN);
  json.set("hardware/pins/echoGpio", ECHO_PIN);
  json.set("hardware/pins/ledGpio", LED_PIN);
  json.set("hardware/pins/buzzerGpio", BUZZER_PIN);
  json.set(
      "hardware/echoVoltageDivider/topOhms",
      ECHO_DIVIDER_TOP_OHMS);
  json.set(
      "hardware/echoVoltageDivider/bottomOhms",
      ECHO_DIVIDER_BOTTOM_OHMS);
  json.set(
      "hardware/echoVoltageDivider/maxOutputVolts",
      ECHO_DIVIDER_MAX_OUTPUT_VOLTS);
  json.set("lastBootAt/.sv", "timestamp");

  const bool success = Firebase.RTDB.setJSON(
      &firebaseData,
      deviceInfoPath,
      &json);
  if (!success) {
    Serial.printf(
        "Device info write failed: %s\n",
        firebaseData.errorReason().c_str());
  }
  return success;
}

bool refreshCalibration() {
  if (!Firebase.RTDB.getJSON(
          &firebaseData,
          deviceConfigPath)) {
    Serial.printf(
        "Calibration read failed; retaining %.2f cm: %s\n",
        persistedRuntime.binHeightCm,
        firebaseData.errorReason().c_str());
    return false;
  }

  FirebaseJson *json = firebaseData.to<FirebaseJson *>();
  if (json == nullptr) {
    return false;
  }

  FirebaseJsonData heightResult;
  FirebaseJsonData versionResult;
  json->get(heightResult, "binHeightCm");
  json->get(versionResult, "calibrationVersion");

  if (!heightResult.success) {
    Serial.println("Calibration ignored: binHeightCm is missing.");
    return false;
  }

  const float newHeightCm = heightResult.to<float>();
  if (!isfinite(newHeightCm) ||
      newHeightCm < MINIMUM_BIN_HEIGHT_CM ||
      newHeightCm > MAXIMUM_BIN_HEIGHT_CM) {
    Serial.println("Calibration ignored: binHeightCm is outside 10-350 cm.");
    return false;
  }

  const uint32_t newVersion =
      versionResult.success
      ? static_cast<uint32_t>(versionResult.to<int>())
      : persistedRuntime.calibrationVersion;

  const bool changed =
      fabsf(newHeightCm - persistedRuntime.binHeightCm) >= 0.01f ||
      newVersion != persistedRuntime.calibrationVersion;

  if (!changed) {
    return true;
  }

  persistedRuntime.binHeightCm = roundToTwoDecimals(newHeightCm);
  persistedRuntime.calibrationVersion = newVersion;
  savePersistedRuntime();
  triggerConfirmationCount = 0;
  resetConfirmationCount = 0;
  forceStatePublish = true;

  Serial.printf(
      "Calibration updated: %.2f cm, version %lu.\n",
      persistedRuntime.binHeightCm,
      static_cast<unsigned long>(persistedRuntime.calibrationVersion));
  return true;
}

bool publishLatestState() {
  FirebaseJson json;
  json.set("schemaVersion", CONTRACT_SCHEMA_VERSION);
  json.set("deviceId", SWADS_DEVICE_ID);
  json.set("binId", SWADS_BIN_ID);
  json.set("bootId", bootId);
  json.set("firmwareVersion", SWADS_FIRMWARE_VERSION);
  json.set("state", binStateName(currentBinState()));
  json.set(
      "alertActive",
      currentBinState() == BinState::CRITICAL);

  if (persistedRuntime.activeAlertCycleId[0] != '\0') {
    json.set(
        "alertCycleId",
        persistedRuntime.activeAlertCycleId);
  } else {
    json.set("alertCycleId");
  }

  addMeasurementJson(json, "measurement", latestMeasurement);
  addThresholdJson(
      json,
      "thresholds",
      persistedRuntime.binHeightCm);
  json.set(
      "confirmation/requiredWindows",
      STATE_CONFIRMATION_WINDOWS);
  json.set(
      "confirmation/triggerWindows",
      triggerConfirmationCount);
  json.set(
      "confirmation/resetWindows",
      resetConfirmationCount);
  json.set("indicators/ledOn", currentBinState() == BinState::CRITICAL);
  json.set(
      "indicators/buzzerEnabled",
      currentBinState() == BinState::CRITICAL);
  json.set("connectivity/wifiConnected", WiFi.status() == WL_CONNECTED);
  json.set("connectivity/wifiRssiDbm", WiFi.RSSI());
  json.set(
      "eventQueue/depth",
      persistedRuntime.pendingEventCount);
  json.set(
      "eventQueue/overflow",
      persistedRuntime.eventQueueOverflow != 0);
  json.set(
      "calibration/binHeightCm",
      persistedRuntime.binHeightCm);
  json.set(
      "calibration/calibrationVersion",
      persistedRuntime.calibrationVersion);
  json.set("lastUpdatedAt/.sv", "timestamp");

  const bool success = Firebase.RTDB.setJSON(
      &firebaseData,
      deviceStatePath,
      &json);
  if (!success) {
    Serial.printf(
        "State write failed: %s\n",
        firebaseData.errorReason().c_str());
  }
  return success;
}

bool publishTelemetry() {
  if (!hasMeasurement) {
    return false;
  }

  const uint32_t nextSequence = telemetrySequence + 1;
  const String telemetryId =
      bootId + "-" + String(nextSequence);
  const String path =
      deviceTelemetryPath + "/" + telemetryId;

  FirebaseJson json;
  json.set("schemaVersion", CONTRACT_SCHEMA_VERSION);
  json.set("telemetryId", telemetryId);
  json.set("telemetrySequence", nextSequence);
  json.set("deviceId", SWADS_DEVICE_ID);
  json.set("binId", SWADS_BIN_ID);
  json.set("bootId", bootId);
  json.set("firmwareVersion", SWADS_FIRMWARE_VERSION);
  json.set("state", binStateName(currentBinState()));
  addMeasurementJson(json, "measurement", latestMeasurement);
  addThresholdJson(
      json,
      "thresholds",
      persistedRuntime.binHeightCm);
  json.set("wifiRssiDbm", WiFi.RSSI());
  json.set(
      "consecutiveInvalidWindows",
      consecutiveInvalidWindows);
  json.set(
      "calibrationVersion",
      persistedRuntime.calibrationVersion);
  json.set("recordedAt/.sv", "timestamp");

  const bool success = Firebase.RTDB.setJSON(
      &firebaseData,
      path,
      &json);
  if (success) {
    telemetrySequence = nextSequence;
  } else {
    Serial.printf(
        "Telemetry write failed: %s\n",
        firebaseData.errorReason().c_str());
  }
  return success;
}

bool publishHeartbeat() {
  FirebaseJson json;
  json.set("schemaVersion", CONTRACT_SCHEMA_VERSION);
  json.set("deviceId", SWADS_DEVICE_ID);
  json.set("binId", SWADS_BIN_ID);
  json.set("bootId", bootId);
  json.set("firmwareVersion", SWADS_FIRMWARE_VERSION);
  json.set("deviceUptimeMs", millis());
  json.set("state", binStateName(currentBinState()));
  json.set("sensorHealth", sensorHealthName(latestMeasurement));
  json.set("wifiRssiDbm", WiFi.RSSI());
  json.set("freeHeapBytes", ESP.getFreeHeap());
  json.set(
      "pendingEventCount",
      persistedRuntime.pendingEventCount);
  json.set(
      "eventQueueOverflow",
      persistedRuntime.eventQueueOverflow != 0);
  json.set("sentAt/.sv", "timestamp");

  const bool success = Firebase.RTDB.setJSON(
      &firebaseData,
      deviceHeartbeatPath,
      &json);
  if (!success) {
    Serial.printf(
        "Heartbeat write failed: %s\n",
        firebaseData.errorReason().c_str());
  }
  return success;
}

Measurement measurementFromEvent(const PendingEvent &event) {
  Measurement measurement;
  measurement.valid = event.measurementValid != 0;
  measurement.distanceCm = event.distanceCm;
  measurement.fillPercent = event.fillPercent;
  measurement.validSampleCount = event.validSampleCount;
  measurement.timeoutSampleCount = event.timeoutSampleCount;
  measurement.outOfRangeSampleCount = event.outOfRangeSampleCount;
  measurement.measuredAtUptimeMs = event.detectedAtUptimeMs;
  return measurement;
}

void removeOldestPendingEvent() {
  if (persistedRuntime.pendingEventCount == 0) {
    return;
  }

  for (uint8_t index = 1;
       index < persistedRuntime.pendingEventCount;
       ++index) {
    persistedRuntime.pendingEvents[index - 1] =
        persistedRuntime.pendingEvents[index];
  }

  --persistedRuntime.pendingEventCount;
  memset(
      &persistedRuntime.pendingEvents[persistedRuntime.pendingEventCount],
      0,
      sizeof(PendingEvent));

  if (persistedRuntime.pendingEventCount < MAX_PENDING_EVENTS) {
    persistedRuntime.eventQueueOverflow = 0;
  }

  savePersistedRuntime();
  forceStatePublish = true;
}

bool publishOldestPendingEvent() {
  if (persistedRuntime.pendingEventCount == 0) {
    return true;
  }

  const PendingEvent &event = persistedRuntime.pendingEvents[0];
  const EventType type = static_cast<EventType>(event.type);
  const Measurement eventMeasurement = measurementFromEvent(event);

  FirebaseJson json;
  json.set("schemaVersion", CONTRACT_SCHEMA_VERSION);
  json.set("eventId", event.eventId);
  json.set("type", eventTypeName(type));
  json.set("source", "ESP32");
  json.set("deviceId", SWADS_DEVICE_ID);
  json.set("binId", SWADS_BIN_ID);
  json.set("firmwareVersion", SWADS_FIRMWARE_VERSION);
  json.set("deviceBootCount", event.bootCount);
  json.set("deviceEventSequence", event.sequence);
  json.set(
      "detectedAtDeviceUptimeMs",
      event.detectedAtUptimeMs);

  if (event.alertCycleId[0] != '\0') {
    json.set("alertCycleId", event.alertCycleId);
  } else {
    json.set("alertCycleId");
  }

  json.set(
      "stateBefore",
      type == EventType::ALERT_80 ? "NORMAL" : "CRITICAL");
  json.set(
      "stateAfter",
      type == EventType::ALERT_80 ? "CRITICAL" : "NORMAL");
  addMeasurementJson(json, "measurement", eventMeasurement);
  addThresholdJson(json, "thresholds", event.binHeightCm);
  json.set("calibration/binHeightCm", event.binHeightCm);
  json.set(
      "calibration/calibrationVersion",
      event.calibrationVersion);
  json.set("receivedAt/.sv", "timestamp");

  const String path = eventRootPath + "/" + event.eventId;
  const bool success = Firebase.RTDB.setJSON(
      &firebaseData,
      path,
      &json);

  if (!success) {
    Serial.printf(
        "%s event write failed: %s\n",
        eventTypeName(type),
        firebaseData.errorReason().c_str());
    return false;
  }

  Serial.printf(
      "%s event delivered: %s\n",
      eventTypeName(type),
      event.eventId);
  removeOldestPendingEvent();
  return true;
}

void configureFirebase() {
  firebaseConfig.api_key = FIREBASE_API_KEY;
  firebaseConfig.database_url = FIREBASE_DATABASE_URL;
  firebaseConfig.token_status_callback = tokenStatusCallback;
  firebaseConfig.timeout.networkReconnect = 10 * 1000;
  firebaseConfig.timeout.socketConnection = 30 * 1000;
  firebaseConfig.timeout.sslHandshake = 60 * 1000;
  firebaseConfig.timeout.serverResponse = 10 * 1000;

  firebaseAuth.user.email = FIREBASE_USER_EMAIL;
  firebaseAuth.user.password = FIREBASE_USER_PASSWORD;

  Firebase.reconnectNetwork(true);
  firebaseData.setBSSLBufferSize(4096, 1024);
  firebaseData.setResponseSize(4096);
  Firebase.begin(&firebaseConfig, &firebaseAuth);
}

void buildFirebasePaths() {
  deviceBasePath =
      String(SWADS_DATABASE_ROOT) +
      "/devices/" +
      SWADS_DEVICE_ID;
  deviceInfoPath = deviceBasePath + "/info";
  deviceConfigPath = deviceBasePath + "/config";
  deviceStatePath = deviceBasePath + "/state";
  deviceHeartbeatPath = deviceBasePath + "/heartbeat";
  deviceTelemetryPath = deviceBasePath + "/telemetry";
  eventRootPath =
      String(SWADS_DATABASE_ROOT) +
      "/events";
}

void validateConfiguration() {
  if (!isValidFirebaseKey(SWADS_DEVICE_ID) ||
      !isValidFirebaseKey(SWADS_BIN_ID)) {
    Serial.println(
        "Fatal configuration error: SWADS_DEVICE_ID and SWADS_BIN_ID "
        "must be valid Firebase keys.");
    while (true) {
      digitalWrite(LED_PIN, !digitalRead(LED_PIN));
      delay(200);
    }
  }

  if (DEFAULT_BIN_HEIGHT_CM < MINIMUM_BIN_HEIGHT_CM ||
      DEFAULT_BIN_HEIGHT_CM > MAXIMUM_BIN_HEIGHT_CM) {
    Serial.println(
        "Fatal configuration error: DEFAULT_BIN_HEIGHT_CM "
        "must be between 10 and 350 cm.");
    while (true) {
      digitalWrite(LED_PIN, !digitalRead(LED_PIN));
      delay(500);
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(TRIGGER_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(TRIGGER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  validateConfiguration();

  preferences.begin("swads", false);
  loadPersistedRuntime();
  ++persistedRuntime.bootCount;
  savePersistedRuntime();

  bootId =
      String(SWADS_DEVICE_ID) +
      "-" +
      String(persistedRuntime.bootCount);
  buildFirebasePaths();

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  configureFirebase();
  updateIndicators(millis());

  Serial.printf(
      "SWADS firmware %s started. Device=%s Bin=%s Boot=%s\n",
      SWADS_FIRMWARE_VERSION,
      SWADS_DEVICE_ID,
      SWADS_BIN_ID,
      bootId.c_str());
}

void loop() {
  const uint32_t now = millis();

  updateIndicators(now);
  maintainWifi(now);

  if (intervalElapsed(now, lastSensorAt, SENSOR_INTERVAL_MS)) {
    lastSensorAt = now;
    latestMeasurement = readFilteredMeasurement();
    hasMeasurement = true;
    evaluateStateMachine(latestMeasurement);

    if (latestMeasurement.valid) {
      Serial.printf(
          "Distance=%.2f cm Fill=%.2f%% State=%s ValidSamples=%u\n",
          latestMeasurement.distanceCm,
          latestMeasurement.fillPercent,
          binStateName(currentBinState()),
          latestMeasurement.validSampleCount);
    } else {
      Serial.printf(
          "Sensor window invalid. Timeouts=%u OutOfRange=%u\n",
          latestMeasurement.timeoutSampleCount,
          latestMeasurement.outOfRangeSampleCount);
    }
  }

  if (!Firebase.ready()) {
    delay(5);
    return;
  }

  if (!firebaseInfoPublished &&
      intervalElapsed(
          now,
          lastInfoAttemptAt,
          CLOUD_WRITE_RETRY_INTERVAL_MS)) {
    lastInfoAttemptAt = now;
    firebaseInfoPublished = publishDeviceInfo();
  }

  if (intervalElapsed(
          now,
          lastConfigRefreshAt,
          CONFIG_REFRESH_INTERVAL_MS)) {
    lastConfigRefreshAt = now;
    refreshCalibration();
  }

  if (persistedRuntime.pendingEventCount > 0 &&
      intervalElapsed(
          now,
          lastEventAttemptAt,
          EVENT_RETRY_INTERVAL_MS)) {
    lastEventAttemptAt = now;
    publishOldestPendingEvent();
  }

  if (forceStatePublish &&
      intervalElapsed(
          now,
          lastForcedSyncAttemptAt,
          CLOUD_WRITE_RETRY_INTERVAL_MS)) {
    lastForcedSyncAttemptAt = now;
    const bool statePublished = publishLatestState();
    const bool telemetryPublished =
        !hasMeasurement || publishTelemetry();
    if (statePublished && telemetryPublished) {
      forceStatePublish = false;
      lastTelemetryAt = now;
    }
  } else if (intervalElapsed(
                 now,
                 lastTelemetryAt,
                 TELEMETRY_INTERVAL_MS) &&
             intervalElapsed(
                 now,
                 lastTelemetryAttemptAt,
                 CLOUD_WRITE_RETRY_INTERVAL_MS)) {
    lastTelemetryAttemptAt = now;
    const bool statePublished = publishLatestState();
    const bool telemetryPublished = publishTelemetry();
    if (statePublished && telemetryPublished) {
      lastTelemetryAt = now;
    }
  }

  if (intervalElapsed(
          now,
          lastHeartbeatAt,
          HEARTBEAT_INTERVAL_MS) &&
      intervalElapsed(
          now,
          lastHeartbeatAttemptAt,
          CLOUD_WRITE_RETRY_INTERVAL_MS)) {
    lastHeartbeatAttemptAt = now;
    if (publishHeartbeat()) {
      lastHeartbeatAt = now;
    }
  }

  delay(5);
}
