#include <Arduino.h>
#include <SPI.h>
#include "DW1000Ranging.h"
#include "DW1000.h"

// Unique address per anchor
// Anchor 1: "86:17:5B:D5:A9:9A:E2:9C"
// Anchor 2: "85:16:5B:D5:A9:9A:E3:9C"
// Anchor 2: "84:15:5B:D5:A9:9A:E3:9C"
#define ANCHOR_ADD "83:14:5B:D5:A9:9A:E2:9C"

// SPI and DW1000 pin definitions
#define PIN_RST 27
#define PIN_SS  4
#define PIN_IRQ 34
#define SPI_SCK 18
#define SPI_MISO 19
#define SPI_MOSI 23

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("==== ESP32 UWB ANCHOR ====");
  Serial.print("Anchor EUI: ");
  Serial.println(ANCHOR_ADD);

  // Initialize SPI
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);

  // Initialize DW1000 communication
  DW1000Ranging.initCommunication(PIN_RST, PIN_SS, PIN_IRQ);

  // Optional: filter out noise by smoothing range results
  // DW1000Ranging.useRangeFilter(true);

  // Attach event handlers
  DW1000Ranging.attachNewRange(newRange);
  DW1000Ranging.attachBlinkDevice(newBlink);
  DW1000Ranging.attachInactiveDevice(inactiveDevice);

  // Start as an anchor node
  DW1000Ranging.startAsAnchor(ANCHOR_ADD, DW1000.MODE_LONGDATA_RANGE_LOWPOWER, false);

  Serial.println("Anchor initialized successfully.");
}

void loop() {
  DW1000Ranging.loop();
}

void newRange() {
  Serial.print("From tag: ");
  Serial.print(DW1000Ranging.getDistantDevice()->getShortAddress(), HEX);
  Serial.print("\t Range: ");
  Serial.print(DW1000Ranging.getDistantDevice()->getRange());
  Serial.print(" m");
  Serial.print("\t RX power: ");
  Serial.print(DW1000Ranging.getDistantDevice()->getRXPower());
  Serial.println(" dBm");
}

void newBlink(DW1000Device *device) {
  Serial.print("New device detected. Short address: ");
  Serial.println(device->getShortAddress(), HEX);
}

void inactiveDevice(DW1000Device *device) {
  Serial.print("Device inactive. Removing: ");
  Serial.println(device->getShortAddress(), HEX);
}