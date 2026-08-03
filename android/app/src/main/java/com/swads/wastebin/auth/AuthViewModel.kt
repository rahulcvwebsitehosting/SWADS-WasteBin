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
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

data class AuthUiState(
    val isLoading: Boolean = false,
    val isSignedIn: Boolean = false,
    val errorMessage: String? = null,
)

class AuthViewModel(application: Application) : AndroidViewModel(application) {
    private val firebaseAuth = FirebaseAuth.getInstance()
    private val database = FirebaseDatabase.getInstance().reference
    private val functions = FirebaseFunctions.getInstance("asia-southeast1")
    private val gmailScope = "https://www.googleapis.com/auth/gmail.send"
    private val webClientId = defaultWebClientId(application)

    private val googleSignInClient =
        GoogleSignIn.getClient(
            application,
            GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(webClientId)
                .requestServerAuthCode(webClientId, true)
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
                val uid =
                    authResult.user?.uid
                        ?: error("Firebase user ID was not returned.")

                functions
                    .getHttpsCallable("saveGoogleOAuthCode")
                    .call(mapOf("code" to serverAuthCode))
                    .await()

                val fcmToken = FirebaseMessaging.getInstance().token.await()
                database
                    .child("swads")
                    .child("v1")
                    .child("users")
                    .child(uid)
                    .child("fcmTokens")
                    .push()
                    .setValue(fcmToken)
                    .await()

                _uiState.value = AuthUiState(isSignedIn = true)
            } catch (exception: Exception) {
                firebaseAuth.signOut()
                _uiState.value =
                    AuthUiState(
                        errorMessage =
                            exception.message ?: "Unable to sign in with Google.",
                    )
            }
        }
    }

    fun signOut() {
        firebaseAuth.signOut()
        googleSignInClient.signOut()
        _uiState.value = AuthUiState()
    }

    private fun defaultWebClientId(application: Application): String {
        val resourceId =
            application.resources.getIdentifier(
                "default_web_client_id",
                "string",
                application.packageName,
            )
        require(resourceId != 0) {
            "default_web_client_id is missing. Add the Firebase google-services.json file."
        }
        return application.getString(resourceId)
    }
}
