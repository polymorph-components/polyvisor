fn main() {
    let proto = "../../../proto/introduction.proto";
    println!("cargo:rerun-if-changed={proto}");
    prost_build::compile_protos(&[proto], &["../../../proto"])
        .expect("introduction protobuf must compile");
}
