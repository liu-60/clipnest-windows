// Example code that deserializes and serializes the model.
// extern crate serde;
// #[macro_use]
// extern crate serde_derive;
// extern crate serde_json;
//
// use generated_module::CompatFixture;
//
// fn main() {
//     let json = r#"{"answer": 42}"#;
//     let model: CompatFixture = serde_json::from_str(&json).unwrap();
// }

use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatFixture {
    pub decimal_id: String,

    pub enabled: bool,

    pub nested: Nested,

    pub numeric_const: f64,

    pub protocol: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Nested {
    pub code: String,
}
