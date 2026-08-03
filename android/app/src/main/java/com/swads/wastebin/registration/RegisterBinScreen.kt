package com.swads.wastebin.registration

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ServerValue
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RegisterBinScreen(
    onRegistered: () -> Unit,
    onBack: () -> Unit,
) {
    var binId by remember { mutableStateOf("") }
    var heightCm by remember { mutableStateOf("") }
    var location by remember { mutableStateOf("") }
    var isSubmitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val coroutineScope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Register Bin") },
                navigationIcon = {
                    TextButton(onClick = onBack) {
                        Text("Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = binId,
                onValueChange = { binId = it },
                label = { Text("Bin ID") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = heightCm,
                onValueChange = { heightCm = it },
                label = { Text("Height (cm)") },
                keyboardOptions =
                    KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = location,
                onValueChange = { location = it },
                label = { Text("Location (PIN or latitude,longitude)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            errorMessage?.let { message ->
                Text(
                    text = message,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Button(
                enabled = !isSubmitting,
                onClick = {
                    coroutineScope.launch {
                        isSubmitting = true
                        errorMessage = null

                        try {
                            val normalizedBinId = binId.trim()
                            val parsedHeight =
                                heightCm.toDoubleOrNull()
                                    ?: error("Enter a valid bin height.")
                            val normalizedLocation = location.trim()

                            if (
                                normalizedBinId.isBlank() ||
                                normalizedBinId.any {
                                    it in setOf('.', '#', '$', '[', ']', '/')
                                }
                            ) {
                                error("Enter a valid Firebase-safe bin ID.")
                            }
                            if (parsedHeight <= 0.0) {
                                error("Bin height must be greater than zero.")
                            }
                            if (normalizedLocation.isBlank()) {
                                error("Enter a location.")
                            }

                            val ownerUid =
                                FirebaseAuth.getInstance().currentUser?.uid
                                    ?: error("Sign in before registering a bin.")
                            val deviceId = "esp32-$normalizedBinId"
                            val binData =
                                mapOf(
                                    "binId" to normalizedBinId,
                                    "deviceId" to deviceId,
                                    "heightCm" to parsedHeight,
                                    "location" to parseLocation(normalizedLocation),
                                    "ownerUid" to ownerUid,
                                    "currentFillPercent" to 0.0,
                                    "currentState" to "NORMAL",
                                    "createdAt" to ServerValue.TIMESTAMP,
                                )
                            val deviceConfig =
                                mapOf(
                                    "schemaVersion" to 1,
                                    "binId" to normalizedBinId,
                                    "binHeightCm" to parsedHeight,
                                    "calibrationVersion" to 1,
                                    "updatedAt" to ServerValue.TIMESTAMP,
                                )
                            val registration =
                                mapOf(
                                    "ownerUid" to ownerUid,
                                    "binId" to normalizedBinId,
                                    "registeredAt" to ServerValue.TIMESTAMP,
                                )
                            val registrationUpdates =
                                mapOf(
                                    "swads/v1/bins/$normalizedBinId" to binData,
                                    "swads/v1/deviceRegistry/$deviceId" to registration,
                                )

                            FirebaseDatabase.getInstance().reference
                                .updateChildren(registrationUpdates)
                                .await()
                            FirebaseDatabase.getInstance().reference
                                .child("swads/v1/devices/$deviceId/config")
                                .setValue(deviceConfig)
                                .await()

                            onRegistered()
                        } catch (exception: Exception) {
                            errorMessage =
                                exception.message ?: "Unable to register the bin."
                        } finally {
                            isSubmitting = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator()
                } else {
                    Text("Submit")
                }
            }
        }
    }
}

private fun parseLocation(value: String): Map<String, Any> {
    val coordinates = value.split(",").map { it.trim() }
    if (coordinates.size == 2) {
        val latitude = coordinates[0].toDoubleOrNull()
        val longitude = coordinates[1].toDoubleOrNull()
        if (
            latitude != null &&
            longitude != null &&
            latitude in -90.0..90.0 &&
            longitude in -180.0..180.0
        ) {
            return mapOf(
                "latitude" to latitude,
                "longitude" to longitude,
            )
        }
    }

    return if (value.all(Char::isDigit)) {
        mapOf("pinCode" to value)
    } else {
        mapOf("address" to value)
    }
}
