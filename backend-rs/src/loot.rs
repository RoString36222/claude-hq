#![allow(dead_code)]
use axum::Router;
pub fn routes() -> Router<crate::AppState> { Router::new() }
