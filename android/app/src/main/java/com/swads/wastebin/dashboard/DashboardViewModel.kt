package com.swads.wastebin.dashboard

import androidx.lifecycle.ViewModel
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ValueEventListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class BinItem(
    val binId: String,
    val currentFillPercent: Double,
    val currentState: String,
)

data class DashboardUiState(
    val isLoading: Boolean = true,
    val bins: List<BinItem> = emptyList(),
    val errorMessage: String? = null,
)

class DashboardViewModel : ViewModel() {
    private val binsReference =
        FirebaseDatabase.getInstance().getReference("bins")

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

    override fun onCleared() {
        binsReference.removeEventListener(binsListener)
        super.onCleared()
    }
}
