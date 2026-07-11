// Prevents an additional console window from opening on Windows in release
// builds. DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    folio_lib::run();
}
