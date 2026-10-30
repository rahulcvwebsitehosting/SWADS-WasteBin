package com.swads.wastebin.registration

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.LaunchedEffect
import com.google.firebase.functions.FirebaseFunctions
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RegisterBinScreen(
    initialBinId: String? = null,
    onRegistered: () -> Unit,
    onBack: () -> Unit,
) {
    var binId by remember { mutableStateOf(initialBinId ?: "") }
    var heightCm by remember { mutableStateOf("") }
    var location by remember { mutableStateOf("") }
    var claimCode by remember { mutableStateOf("") }
    var contactEmail by remember { mutableStateOf("") }
    var contactOrganization by remember { mutableStateOf("") }
    var contactSource by remember { mutableStateOf("") }
    var contactVerified by remember { mutableStateOf(false) }
    var isSubmitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val coroutineScope = rememberCoroutineScope()

    LaunchedEffect(initialBinId) {
        if (initialBinId != null) {
            isSubmitting = true
            try {
                val snapshot = FirebaseDatabase.getInstance().getReference("swads/v1/bins/$initialBinId").get().await()
                heightCm = snapshot.child("heightCm").value?.toString() ?: ""
                val loc = snapshot.child("location")
                location = loc.child("pinCode").value?.toString() ?: loc.child("address").value?.toString()
                    ?: "${loc.child("latitude").value},${loc.child("longitude").value}"
                val contact = snapshot.child("dispatchContacts").children.firstOrNull()
                contactEmail = contact?.child("email")?.value?.toString() ?: ""
                contactOrganization = contact?.child("organization")?.value?.toString() ?: ""
                contactSource = contact?.child("sourceUrl")?.value?.toString() ?: ""
                contactVerified = contact?.child("verified")?.value == true
            } catch (exception: Exception) { errorMessage = exception.message ?: "Unable to load bin settings." }
            finally { isSubmitting = false }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (initialBinId == null) "Register Bin" else "Bin Settings") },
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
                enabled = initialBinId == null && !isSubmitting,
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

            if (initialBinId == null) {
                OutlinedTextField(value = claimCode, onValueChange = { claimCode = it },
                    label = { Text("Device claim code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            Text("Collection contact (optional)", style = MaterialTheme.typography.titleMedium)
            Text("Monitoring works without a contact. Automatic requests need a verified email for this bin's area.")
            OutlinedTextField(value = contactEmail, onValueChange = { contactEmail = it; contactVerified = false },
                label = { Text("Collection email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = contactOrganization, onValueChange = { contactOrganization = it; contactVerified = false },
                label = { Text("Organization") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = contactSource, onValueChange = { contactSource = it; contactVerified = false },
                label = { Text("HTTPS page listing this email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Row {
                Checkbox(checked = contactVerified, onCheckedChange = { contactVerified = it })
                Text("I checked that this email belongs to the organization and serves this bin's location.")
            }

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
                            if (parsedHeight !in 10.0..350.0) {
                                error("Bin height must be between 10 and 350 cm.")
                            }
                            if (normalizedLocation.isBlank()) {
                                error("Enter a location.")
                            }

                            checkNotNull(FirebaseAuth.getInstance().currentUser?.uid) { "Sign in before registering a bin." }
                            val contacts = if (contactEmail.isBlank() && contactOrganization.isBlank() && contactSource.isBlank()) {
                                emptyList<Map<String, Any>>()
                            } else {
                                check(contactVerified) { "Verify the collection contact before saving." }
                                listOf(mapOf("email" to contactEmail.trim(), "organization" to contactOrganization.trim(),
                                    "sourceUrl" to contactSource.trim(), "verified" to true))
                            }
                            FirebaseFunctions.getInstance("asia-southeast1").getHttpsCallable("registerBin")
                                .call(mapOf("binId" to normalizedBinId, "heightCm" to parsedHeight,
                                    "location" to parseLocation(normalizedLocation), "claimCode" to claimCode.trim(),
                                    "dispatchContacts" to contacts)).await()

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
                    Text(if (initialBinId == null) "Register" else "Save Settings")
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
