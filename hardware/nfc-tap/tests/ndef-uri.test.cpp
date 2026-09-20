// Pure format validation, no fake I2C or hardware verification.
#include "../medbridge_nfc_tap/NdefUri.h"
#include <assert.h>
#include <stdio.h>
#include <string>
int main() {
  uint8_t image[MedBridgeNdef::IMAGE_SIZE];
  char decoded[MedBridgeNdef::MAX_URL + 1];
  const char *url = "https://example.com/medications/example-1_34mg";
  assert(MedBridgeNdef::encode(url, image));
  assert(image[8] == 0x03 && image[10] == 0xD1 && image[13] == 'U' && image[14] == 0x04);
  assert(image[9] == strlen(url) - 8 + 5);
  assert(MedBridgeNdef::decode(image, decoded)); assert(!strcmp(url, decoded));
  for (size_t i = 0; i < 15; ++i) {
    image[i] ^= 1; assert(!MedBridgeNdef::decode(image, decoded)); image[i] ^= 1;
  }
  image[15] = 0; assert(!MedBridgeNdef::decode(image, decoded));
  assert(!MedBridgeNdef::encode("http://example.com/medications/drug", image));
  assert(!MedBridgeNdef::encode("https://localhost/medications/drug", image));
  assert(!MedBridgeNdef::encode("https://127.0.0.1/medications/drug", image));
  assert(!MedBridgeNdef::encode("https://example.com/medications/drug?patient=123", image));
  assert(!MedBridgeNdef::encode("https://example.com/medications/drug\nREAD_NDEF", image));
  std::string longest = "https://example.com/medications/";
  longest += std::string(MedBridgeNdef::MAX_URL - longest.size(), 'a');
  assert(MedBridgeNdef::encode(longest.c_str(), image));
  assert(MedBridgeNdef::decode(image, decoded)); assert(longest == decoded);
  longest += 'a'; assert(!MedBridgeNdef::encode(longest.c_str(), image));
  assert(MedBridgeNdef::encode("https://example.com/medications/b", image));
  assert(MedBridgeNdef::decode(image, decoded)); assert(!strcmp(decoded, "https://example.com/medications/b"));
  puts("NDEF codec checks passed (not a hardware test).");
}
