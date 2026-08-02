package com.swads.wastebin

import androidx.compose.runtime.Composable
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.google.firebase.auth.FirebaseAuth
import com.swads.wastebin.auth.AuthViewModel
import com.swads.wastebin.auth.LoginScreen
import com.swads.wastebin.dashboard.DashboardScreen
import com.swads.wastebin.dashboard.DashboardViewModel
import com.swads.wastebin.registration.RegisterBinScreen

private object Routes {
    const val LOGIN = "login"
    const val DASHBOARD = "dashboard"
    const val REGISTER = "register"
}

@Composable
fun SWADSApp() {
    val navController = rememberNavController()
    val authViewModel: AuthViewModel = viewModel()
    val startDestination =
        if (FirebaseAuth.getInstance().currentUser == null) {
            Routes.LOGIN
        } else {
            Routes.DASHBOARD
        }

    NavHost(
        navController = navController,
        startDestination = startDestination,
    ) {
        composable(Routes.LOGIN) {
            LoginScreen(
                viewModel = authViewModel,
                onSignedIn = {
                    navController.navigate(Routes.DASHBOARD) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.DASHBOARD) {
            val dashboardViewModel: DashboardViewModel = viewModel()
            DashboardScreen(
                viewModel = dashboardViewModel,
                onRegisterBin = {
                    navController.navigate(Routes.REGISTER)
                },
                onSignOut = {
                    authViewModel.signOut()
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.DASHBOARD) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.REGISTER) {
            RegisterBinScreen(
                onRegistered = { navController.popBackStack() },
                onBack = { navController.popBackStack() },
            )
        }
    }
}
