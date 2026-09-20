#ifndef MEDIZ_NDEF_URI_H
#define MEDIZ_NDEF_URI_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace MediZNdef {
const size_t MAX_URL = 240;
const size_t IMAGE_SIZE = 256;
// NFC Forum Type 5 CC: 8 KiB ST25DV64, two-byte block addressing, 8184-byte data area.
const uint8_t CC[8] = {0xE2, 0x40, 0x00, 0x01, 0x00, 0x00, 0x03, 0xFF};
inline bool alnum(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); }
inline bool validUrl(const char *url) {
  const size_t length = strlen(url);
  if (length > MAX_URL || strncmp(url, "https://", 8) != 0) return false;
  const char *host = url + 8;
  const char *path = strchr(host, '/');
  if (!path || path == host || strncmp(path, "/medications/", 13) != 0) return false;
  bool dot = false, port = false;
  for (const char *p = host; p < path; ++p) {
    if (*p == ':' && !port && p > host && p + 1 < path) { port = true; continue; }
    if (port) { if (*p < '0' || *p > '9') return false; }
    else { if (*p == '.') dot = true; else if (!alnum(*p) && *p != '-') return false; }
  }
  if (!dot || !alnum(*host) || strncmp(host, "127.0.0.1", 9) == 0 || strncmp(host, "0.0.0.0", 7) == 0) return false;
  const char *hostEnd = strchr(host, ':'); if (!hostEnd || hostEnd > path) hostEnd = path;
  if (hostEnd - host >= 10 && strncmp(hostEnd - 10, ".localhost", 10) == 0) return false;
  const char *slug = path + 13;
  if (!*slug) return false;
  for (const char *p = slug; *p; ++p) if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '-' || *p == '_')) return false;
  return true;
}
inline bool encode(const char *url, uint8_t *image) {
  if (!validUrl(url)) return false;
  const size_t suffix = strlen(url) - 8;
  memset(image, 0, IMAGE_SIZE);
  memcpy(image, CC, sizeof(CC));
  image[8] = 0x03;                 // NDEF Message TLV
  image[9] = uint8_t(suffix + 5);  // Entire NDEF record length (<255)
  image[10] = 0xD1;                // MB=1, ME=1, SR=1, TNF=well-known
  image[11] = 1;                   // Type length
  image[12] = uint8_t(suffix + 1); // Payload length, including URI prefix code
  image[13] = 0x55;                // 'U' URI record type
  image[14] = 0x04;                // NFC URI prefix: https://
  memcpy(image + 15, url + 8, suffix);
  image[15 + suffix] = 0xFE;       // Terminator TLV
  return true;
}
inline bool decode(const uint8_t *image, char *url) {
  if (memcmp(image, CC, sizeof(CC)) != 0 || image[8] != 3 || image[10] != 0xD1 || image[11] != 1 || image[13] != 0x55 || image[14] != 4 || image[12] < 2) return false;
  const size_t suffix = image[12] - 1;
  if (suffix + 8 > MAX_URL || image[9] != suffix + 5 || image[15 + suffix] != 0xFE) return false;
  for (size_t i = 0; i < suffix; ++i) if (image[15 + i] < 0x21 || image[15 + i] > 0x7E) return false;
  memcpy(url, "https://", 8); memcpy(url + 8, image + 15, suffix); url[8 + suffix] = 0;
  return validUrl(url);
}
}
#endif
