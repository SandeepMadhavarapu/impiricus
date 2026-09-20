// Pure format validation, no fake I2C or hardware verification.
#include "../mediz_nfc_tap/NdefUri.h"
#include <assert.h>
#include <stdio.h>
#include <string>
int main() {
  uint8_t image[MediZNdef::IMAGE_SIZE];
  char decoded[MediZNdef::MAX_URL + 1];
  const char *url = "https://example.com/medications/example-1_34mg";
  assert(MediZNdef::encode(url, image));
  assert(image[8] == 0x03 && image[10] == 0xD1 && image[13] == 'U' && image[14] == 0x04);
  assert(image[9] == strlen(url) - 8 + 5);
  assert(MediZNdef::decode(image, decoded)); assert(!strcmp(url, decoded));
  for (size_t i = 0; i < 15; ++i) {
    image[i] ^= 1; assert(!MediZNdef::decode(image, decoded)); image[i] ^= 1;
  }
  image[15] = 0; assert(!MediZNdef::decode(image, decoded));
  assert(!MediZNdef::encode("http://example.com/medications/drug", image));
  assert(!MediZNdef::encode("https://localhost/medications/drug", image));
  assert(!MediZNdef::encode("https://127.0.0.1/medications/drug", image));
  assert(!MediZNdef::encode("https://example.com/medications/drug?patient=123", image));
  assert(!MediZNdef::encode("https://example.com/medications/drug\nREAD_NDEF", image));
  std::string longest = "https://example.com/medications/";
  longest += std::string(MediZNdef::MAX_URL - longest.size(), 'a');
  assert(MediZNdef::encode(longest.c_str(), image));
  assert(MediZNdef::decode(image, decoded)); assert(longest == decoded);
  longest += 'a'; assert(!MediZNdef::encode(longest.c_str(), image));
  assert(MediZNdef::encode("https://example.com/medications/b", image));
  assert(MediZNdef::decode(image, decoded)); assert(!strcmp(decoded, "https://example.com/medications/b"));
  puts("NDEF codec checks passed (not a hardware test).");
}
