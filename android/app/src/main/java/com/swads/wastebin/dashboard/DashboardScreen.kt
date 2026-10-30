package com.swads.wastebin.dashboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLocale
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    viewModel: DashboardViewModel,
    onRegisterBin: () -> Unit,
    onEditBin: (String) -> Unit,
    onSignOut: () -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var reviewBin by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(15000) } }
    reviewBin?.let { binId ->
        AlertDialog(onDismissRequest = { reviewBin = null },
            title = { Text("Check Sent mail first") },
            text = { Text("The previous delivery outcome is unknown. Retry only after checking that no collection email for this alert appears in your Gmail Sent folder.") },
            confirmButton = { TextButton(onClick = { reviewBin = null; viewModel.retryCollection(binId, true) }) { Text("Checked, no email — retry") } },
            dismissButton = { TextButton(onClick = { reviewBin = null }) { Text("Cancel") } })
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("SWADS Dashboard") },
                actions = {
                    TextButton(onClick = onSignOut) {
                        Text("Sign out")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding),
        ) {
            Button(
                onClick = onRegisterBin,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Text("Register Bin")
            }

            uiState.actionMessage?.let { Text(it, modifier = Modifier.padding(16.dp)) }
            when {
                uiState.isLoading -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.errorMessage != null -> {
                    Text(
                        text = uiState.errorMessage.orEmpty(),
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(16.dp),
                    )
                }

                uiState.bins.isEmpty() -> {
                    Text(
                        text = "No bins registered.",
                        modifier = Modifier.padding(16.dp),
                    )
                }

                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(
                            items = uiState.bins,
                            key = { it.binId },
                        ) { bin ->
                            BinCard(bin, now, onEdit = { onEditBin(bin.binId) }, onRetry = {
                                if (bin.dispatchStatus == "ReviewRequired") reviewBin = bin.binId
                                else viewModel.retryCollection(bin.binId)
                            })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BinCard(bin: BinItem, now: Long, onEdit: () -> Unit, onRetry: () -> Unit) {
    val locale = LocalLocale.current.platformLocale
    val isCritical = bin.currentState == "ALERT_80"
    val containerColor =
        if (isCritical) {
            Color(0xFFD32F2F)
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        }
    val contentColor =
        if (isCritical) {
            Color.White
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors =
            CardDefaults.cardColors(
                containerColor = containerColor,
                contentColor = contentColor,
            ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = bin.binId,
                style = MaterialTheme.typography.titleMedium,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    String.format(
                        locale,
                        "%.1f%% full",
                        bin.currentFillPercent,
                    ),
                )
                Text(bin.currentState)
            }
            val stale = bin.lastTelemetryAt == 0L || now - bin.lastTelemetryAt > 180000L
            when {
                bin.lastTelemetryAt == 0L -> Text("Waiting for device connection and first reading.")
                stale -> Text("Device offline or readings delayed. The displayed value may be out of date.")
                !bin.measurementValid -> Text("Sensor needs attention: ${bin.sensorHealth}. Showing the last valid value.")
                bin.sensorHealth == "DEGRADED" -> Text("Some sensor samples were invalid.")
            }
            if (bin.lastValidMeasurementAt > 0L) {
                Text("Last valid reading: ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(bin.lastValidMeasurementAt))}")
            }
            if (bin.currentState == "ALERT_80" && bin.dispatchStatus.isNotBlank()) Text("Collection request: ${bin.dispatchStatus}")
            Row {
                TextButton(onClick = onEdit) { Text("Settings / Contact") }
                if (bin.currentState == "ALERT_80" && bin.dispatchStatus in setOf("NeedsContacts", "DispatchFailed", "ReviewRequired", "RetryPending", "WaitingForDevice")) {
                    TextButton(onClick = onRetry) { Text("Retry Request") }
                }
            }
        }
    }
}
