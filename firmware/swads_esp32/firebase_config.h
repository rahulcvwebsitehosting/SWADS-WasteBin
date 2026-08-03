#pragma once

#if __has_include("firebase_secrets.h")
#include "firebase_secrets.h"
#endif

// Wi-Fi credentials used by this ESP32 installation.
#ifndef WIFI_SSID
#define WIFI_SSID "YOUR_WIFI_SSID"
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#endif

// Firebase project Web API key and Realtime Database URL.
// DATABASE_URL examples:
//   https://your-project-default-rtdb.firebaseio.com
//   https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app
#define FIREBASE_API_KEY "AIzaSyB0aeSnlS2BTcaA4KfA0lXzVQqV8DWKmV4"
#define FIREBASE_DATABASE_URL \
  "https://swads-wastebin-default-rtdb.asia-southeast1.firebasedatabase.app"

// Create a dedicated Firebase Authentication Email/Password user for this device.
// Realtime Database Security Rules should restrict this UID to SWADS_DEVICE_ID.
#ifndef FIREBASE_USER_EMAIL
#define FIREBASE_USER_EMAIL "esp32-bin-001@swads.local"
#endif
#ifndef FIREBASE_USER_PASSWORD
#define FIREBASE_USER_PASSWORD "REPLACE_WITH_A_STRONG_DEVICE_PASSWORD"
#endif

// Firebase keys cannot contain '.', '$', '#', '[', ']', '/', or control characters.
#define SWADS_DEVICE_ID "esp32-bin-001"
#define SWADS_BIN_ID "bin-001"

#define SWADS_FIRMWARE_VERSION "1.0.0"
#define SWADS_DATABASE_ROOT "/swads/v1"

// Used until /swads/v1/devices/{deviceId}/config is available.
#define DEFAULT_BIN_HEIGHT_CM 50.0f
