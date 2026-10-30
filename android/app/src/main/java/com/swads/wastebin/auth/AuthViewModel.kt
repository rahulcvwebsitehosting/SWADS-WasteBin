package com.swads.wastebin.auth

import android.app.Application
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.Scope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.functions.FirebaseFunctions
import com.swads.wastebin.R
import com.swads.wastebin.Notifications
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull

data class AuthUiState(
    val isLoading: Boolean = false,
    val isSignedIn: Boolean = false,
    val errorMessage: String? = null,
)

class AuthViewModel(application: Application) : AndroidViewModel(application) {
    private val firebaseAuth = FirebaseAuth.getInstance()
    private val functions = FirebaseFunctions.getInstance("asia-southeast1")
    private val gmailScope = "https://www.googleapis.com/auth/gmail.send"
    private val webClientId = defaultWebClientId(application)

    private val googleSignInClient =
        GoogleSignIn.getClient(
            application,
            GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(webClientId)
                .requestServerAuthCode(webClientId, false)
                .requestEmail()
                .requestScopes(Scope(gmailScope))
                .build(),
        )

    private val _uiState =
        MutableStateFlow(
            AuthUiState(isSignedIn = firebaseAuth.currentUser != null),
        )
    val uiState: StateFlow<AuthUiState> = _uiState.asStateFlow()

    fun getGoogleSignInIntent(): Intent = googleSignInClient.signInIntent

    fun handleGoogleSignInResult(data: Intent?) {
        if (data == null) {
            _uiState.value = AuthUiState(errorMessage = "Google Sign-In was cancelled.")
            return
        }

        viewModelScope.launch {
            _uiState.value = AuthUiState(isLoading = true)

            try {
                val googleAccount =
                    GoogleSignIn.getSignedInAccountFromIntent(data).await()
                val idToken =
                    googleAccount.idToken
                        ?: error("Google ID token was not returned.")
                val serverAuthCode =
                    googleAccount.serverAuthCode
                        ?: error("Google authorization code was not returned.")

                val firebaseCredential =
                    GoogleAuthProvider.getCredential(idToken, null)
                val authResult =
                    firebaseAuth.signInWithCredential(firebaseCredential).await()
                checkNotNull(authResult.user?.uid) { "Firebase user ID was not returned." }

                functions
                    .getHttpsCallable("saveGoogleOAuthCode")
                    .call(mapOf("code" to serverAuthCode))
                    .await()

                // A notification-service outage must not undo a successful login.
                runCatching { withTimeoutOrNull(5000) { Notifications.syncToken(getApplication()).await() } }

                _uiState.value = AuthUiState(isSignedIn = true)
            } catch (exception: Exception) {
                firebaseAuth.signOut()
                runCatching { googleSignInClient.signOut().await() }
                _uiState.value =
                    AuthUiState(
                        errorMessage =
                            exception.message ?: "Unable to sign in with Google.",
                    )
            }
        }
    }

    fun signOut(onComplete: () -> Unit) {
        viewModelScope.launch {
            firebaseAuth.currentUser?.uid?.let { uid ->
                runCatching { withTimeoutOrNull(3000) { Notifications.unregister(getApplication(), uid).await() } }
            }
            firebaseAuth.signOut()
            runCatching { googleSignInClient.signOut().await() }
            _uiState.value = AuthUiState()
            onComplete()
        }
    }

    private fun defaultWebClientId(application: Application): String {
        return application.getString(R.string.default_web_client_id)
    }
}
