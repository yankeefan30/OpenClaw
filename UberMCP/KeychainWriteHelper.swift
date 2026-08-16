import Foundation
import Security

guard CommandLine.arguments.count == 3 else { exit(64) }
let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let secret = FileHandle.standardInput.readDataToEndOfFile()
guard !secret.isEmpty, secret.count <= 1_048_576 else { exit(65) }

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account
]
let update: [String: Any] = [kSecValueData as String: secret]
let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)

if status == errSecItemNotFound {
    var add = query
    add[kSecValueData as String] = secret
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { exit(74) }
} else if status != errSecSuccess {
    exit(74)
}
