/* MedBridge NFC memory proof: UNO R4 WiFi + Grove ST25DV64 via standard Wire.
 * Dependency: STM32duino ST25DV 2.2.0 (STMicroelectronics).
 * No RF/phone-tap success is implied. See ../README.md before uploading.
 */
#include <Wire.h>
#include <ST25DVSensor.h> // Root header lets Arduino discover the ST25DV library.
#include "NdefUri.h"

// Only the low-level I2C driver is used. GPO/LPD are not wired or initialized.
ST25DV_IO chip(-1, -1, &Wire);
char line[301];
size_t used = 0;
bool overflow = false;
uint8_t wanted[MedBridgeNdef::IMAGE_SIZE];
uint8_t actual[MedBridgeNdef::IMAGE_SIZE];
char readUrl[MedBridgeNdef::MAX_URL + 1];

void reply(const char *kind, const char *id, const char *value) {
  Serial.print(kind); Serial.print(' '); Serial.print(id); Serial.print(' '); Serial.println(value);
}
bool chipPresent() {
  uint8_t id = 0;
  return chip.ST25DV_i2c_ReadID(&id) == NFCTAG_OK && (id == I_AM_ST25DV64 || id == I_AM_ST25DV64KC);
}
// Count-checked Wire reads: the upstream low-level read helper does not reject
// short requestFrom responses. Never accept bytes left in RAM as hardware proof.
bool readChip(uint16_t address, uint8_t *data, size_t length) {
  memset(data, 0, length);
  while (length) {
    const uint8_t count = length > 16 ? 16 : uint8_t(length);
    const uint8_t device = ST25DV_ADDR_DATA_I2C >> 1;
    Wire.beginTransmission(device);
    Wire.write(uint8_t(address >> 8)); Wire.write(uint8_t(address));
    if (Wire.endTransmission() != 0) return false;
    if (Wire.requestFrom(device, count) != count) { while (Wire.available()) Wire.read(); return false; }
    for (uint8_t i = 0; i < count; ++i) { if (!Wire.available()) return false; data[i] = uint8_t(Wire.read()); }
    data += count; address += count; length -= count;
  }
  return true;
}
bool writeChip(uint16_t address, const uint8_t *data, size_t length) {
  while (length) {
    const uint8_t count = length > 16 ? 16 : uint8_t(length);
    if (chip.ST25DV_i2c_WriteData(data, address, count) != NFCTAG_OK) return false;
    data += count; address += count; length -= count;
  }
  return true;
}
bool readNdef() {
  readUrl[0] = 0;
  return readChip(0, actual, sizeof(actual)) && MedBridgeNdef::decode(actual, readUrl);
}
bool validId(const char *id) {
  if (strlen(id) != 8) return false;
  for (size_t i = 0; i < 8; ++i) if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return false;
  return true;
}
void command(char *input) {
  char *separator = strchr(input, ' ');
  if (!separator) { reply("ERROR", "00000000", "MALFORMED_COMMAND"); return; }
  *separator = 0; char *id = separator + 1;
  char *url = strchr(id, ' ');
  if (url) { *url = 0; ++url; }
  if (!validId(id)) { reply("ERROR", "00000000", "MALFORMED_COMMAND"); return; }
  if (!strcmp(input, "HELLO") && !url) {
    if (chipPresent()) reply("READY", id, "MEDBRIDGE_NFC"); else reply("ERROR", id, "INIT_FAILED");
    return;
  }
  if (!strcmp(input, "READ_NDEF") && !url) {
    reply("STATUS", id, "READING");
    if (!readNdef()) { reply("ERROR", id, "READ_FAILED"); return; }
    reply("NDEF_URI", id, readUrl); return;
  }
  if (strcmp(input, "PROGRAM_NDEF_URI") || !url) { reply("ERROR", id, "MALFORMED_COMMAND"); return; }
  if (!MedBridgeNdef::encode(url, wanted)) { reply("ERROR", id, "INVALID_URL"); return; }
  if (!chipPresent()) { reply("ERROR", id, "INIT_FAILED"); return; }
  reply("STATUS", id, "WRITING");
  // Invalidate the TLV length first; publish its valid length only after body write.
  const uint8_t emptyTlv[2] = {0x03, 0x00};
  if (!writeChip(8, emptyTlv, 2) || !writeChip(0, wanted, 8) ||
      !writeChip(10, wanted + 10, sizeof(wanted) - 10) || !writeChip(8, wanted + 8, 2)) {
    reply("ERROR", id, "WRITE_FAILED"); return;
  }
  reply("STATUS", id, "READING");
  // Fresh I2C transactions populate a SEPARATE buffer, not a write-buffer echo.
  if (!readChip(0, actual, sizeof(actual))) { reply("ERROR", id, "READ_FAILED"); return; }
  if (memcmp(wanted, actual, sizeof(actual)) || !MedBridgeNdef::decode(actual, readUrl) || strcmp(url, readUrl)) {
    reply("ERROR", id, "VERIFY_MISMATCH"); return;
  }
  reply("VERIFIED", id, readUrl); // The only VERIFIED emission in this firmware.
}
void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(100000);
  const unsigned long start = millis();
  while (!Serial && millis() - start < 3000) { delay(10); }
  if (chipPresent()) Serial.println("READY MEDBRIDGE_NFC");
  else reply("ERROR", "00000000", "INIT_FAILED");
}
void loop() {
  while (Serial.available()) {
    const char c = char(Serial.read());
    if (c == '\n') {
      if (overflow) reply("ERROR", "00000000", "MALFORMED_COMMAND");
      else { if (used && line[used - 1] == '\r') --used; line[used] = 0; if (used) command(line); }
      used = 0; overflow = false;
    } else if (used >= sizeof(line) - 1 || (c != '\r' && (c < 0x20 || c > 0x7E))) overflow = true;
    else if (!overflow) line[used++] = c;
  }
}
