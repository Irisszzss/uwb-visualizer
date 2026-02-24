#include <SPI.h>
#include <DW1000Ranging.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "DW1000.h"
#include "link.h"

// UWB Pins
#define SPI_SCK 18
#define SPI_MISO 19
#define SPI_MOSI 23
#define DW_CS 4
#define PIN_RST 27
#define PIN_IRQ 34

// BLE UUIDs
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLECharacteristic *pCharacteristic;
bool deviceConnected = false;
struct MyLink *uwb_data;
long runtime = 0;
String all_json = "";

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { deviceConnected = true; };
    void onDisconnect(BLEServer* pServer) { 
      deviceConnected = false; 
      BLEDevice::startAdvertising(); // Restart advertising to reconnect
    }
};

void setup() {
  Serial.begin(115200);

  // Initialize BLE
  BLEDevice::init("UWB_Tag_Board");
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);
  
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ |
                      BLECharacteristic::PROPERTY_NOTIFY
                    );
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();
  
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("BLE Advertising Started...");

  // Initialize UWB
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
  DW1000Ranging.initCommunication(PIN_RST, DW_CS, PIN_IRQ);
  DW1000Ranging.attachNewRange(newRange);
  DW1000Ranging.attachNewDevice(newDevice);
  DW1000Ranging.attachInactiveDevice(inactiveDevice);
  DW1000Ranging.startAsTag("7D:00:22:EA:82:60:3B:9C", DW1000.MODE_LONGDATA_RANGE_LOWPOWER, false);
  uwb_data = init_link();
}

void loop() {
  DW1000Ranging.loop();
  
  if (deviceConnected && (millis() - runtime) > 100) {
    make_link_json(uwb_data, &all_json);
    // BLE characteristic size limit is usually 20-512 bytes. 
    // Ensure your JSON isn't too huge or increase MTU.
    pCharacteristic->setValue(all_json.c_str());
    pCharacteristic->notify(); 
    runtime = millis();
  }
}

/* --- WebSocket Server Event Handler if using wifi ---
void webSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.printf("Client #%u disconnected.\n", num);
      break;
    case WStype_CONNECTED: {
        IPAddress ip = webSocket.remoteIP(num);
        Serial.printf("Client #%u connected from %s\n", num, ip.toString().c_str());
        webSocket.sendTXT(num, "Welcome to the UWB Server!");
      }
      break;
    case WStype_TEXT:
      Serial.printf("Client #%u sent text: %s\n", num, payload);
      break;
  }
} */

void newRange() {
  Serial.print("from: ");
  Serial.print(DW1000Ranging.getDistantDevice()->getShortAddress(), HEX);
  Serial.print("\t Range: ");
  Serial.print(DW1000Ranging.getDistantDevice()->getRange());
  Serial.print(" m");
  Serial.print("\t RX power: ");
  Serial.print(DW1000Ranging.getDistantDevice()->getRXPower());
  Serial.println(" dBm");

  fresh_link(
    uwb_data,
    DW1000Ranging.getDistantDevice()->getShortAddress(),
    DW1000Ranging.getDistantDevice()->getRange(),
    DW1000Ranging.getDistantDevice()->getRXPower()
  );
}

void newDevice(DW1000Device *device) {
  Serial.print("Ranging init; 1 device added -> short:");
  Serial.println(device->getShortAddress(), HEX);
  add_link(uwb_data, device->getShortAddress());
}

void inactiveDevice(DW1000Device *device) {
  Serial.print("Delete inactive device: ");
  Serial.println(device->getShortAddress(), HEX);
  delete_link(uwb_data, device->getShortAddress());
}