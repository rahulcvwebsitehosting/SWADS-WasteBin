package com.swads.wastebin.dashboard

import androidx.lifecycle.ViewModel
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ValueEventListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import androidx.lifecycle.viewModelScope
import com.google.firebase.functions.FirebaseFunctions
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

data class BinItem(
    val binId: String,
    val currentFillPercent: Double,
    val currentState: String,
    val lastTelemetryAt: Long = 0,
    val lastValidMeasurementAt: Long = 0,
    val measurementValid: Boolean = false,
    val sensorHealth: String = "INITIALIZING",
    val dispatchStatus: String = "",
)

data class DashboardUiState(
    val isLoading: Boolean = true,
    val bins: List<BinItem> = emptyList(),
    val errorMessage: String? = null,
    val actionMessage: String? = null,
)

class DashboardViewModel : ViewModel() {
    private val ownerUid =
        FirebaseAuth.getInstance().currentUser?.uid
            ?: error("A signed-in user is required for the dashboard.")
    private val binsReference =
        FirebaseDatabase
            .getInstance()
            .getReference("swads/v1/bins")
            .orderByChild("ownerUid")
            .equalTo(ownerUid)

    private val _uiState = MutableStateFlow(DashboardUiState())
    val uiState: StateFlow<DashboardUiState> = _uiState.asStateFlow()

    private val binsListener =
        object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val bins =
                    snapshot.children
                        .mapNotNull { binSnapshot ->
                            val binId =
                                binSnapshot
                                    .child("binId")
                                    .getValue(String::class.java)
                                    ?: binSnapshot.key
                                    ?: return@mapNotNull null
                            val fillPercent =
                                (binSnapshot.child("currentFillPercent").value as? Number)
                                    ?.toDouble()
                                    ?: 0.0
                            val state =
                                binSnapshot
                                    .child("currentState")
                                    .getValue(String::class.java)
                                    ?: "NORMAL"

                            BinItem(
                                binId = binId,
                                currentFillPercent = fillPercent,
                                currentState = state,
                                lastTelemetryAt = (binSnapshot.child("lastTelemetryAt").value as? Number)?.toLong() ?: 0,
                                lastValidMeasurementAt = (binSnapshot.child("lastValidMeasurementAt").value as? Number)?.toLong() ?: 0,
                                measurementValid = binSnapshot.child("measurementValid").value == true,
                                sensorHealth = binSnapshot.child("sensorHealth").value?.toString() ?: "INITIALIZING",
                                dispatchStatus = binSnapshot.child("dispatchStatus").value?.toString() ?: "",
                            )
                        }.sortedBy { it.binId }

                _uiState.value =
                    DashboardUiState(
                        isLoading = false,
                        bins = bins,
                    )
            }

            override fun onCancelled(error: DatabaseError) {
                _uiState.value =
                    DashboardUiState(
                        isLoading = false,
                        errorMessage = error.message,
                    )
            }
        }

    init {
        binsReference.addValueEventListener(binsListener)
    }

    fun retryCollection(binId: String, checkedSentMail: Boolean = false) {
        viewModelScope.launch {
            try {
                FirebaseFunctions.getInstance("asia-southeast1").getHttpsCallable("retryCollectionRequest")
                    .call(mapOf("binId" to binId, "checkedSentMail" to checkedSentMail)).await()
                _uiState.value = _uiState.value.copy(actionMessage = "Collection request queued for retry.")
            } catch (exception: Exception) {
                _uiState.value = _uiState.value.copy(actionMessage = exception.message ?: "Unable to retry.")
            }
        }
    }

    override fun onCleared() {
        binsReference.removeEventListener(binsListener)
        super.onCleared()
    }
}
