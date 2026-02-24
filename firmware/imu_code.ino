#include <esp_now.h>
#include <WiFi.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Wire.h>
#include <Adafruit_BNO08x.h>

#define I2C_SDA 8
#define I2C_SCL 9
#define FSR_PIN 1
#define BTN_NEW_PAGE 2

#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLECharacteristic *pCharacteristic;
bool deviceConnected = false;
Adafruit_BNO08x bno08x;
sh2_SensorValue_t sensorValue;
bool bnoFound = false;

// CACHE: Stores ranges for React
String r1786 = "0.00", r1685 = "0.00", r1584 = "0.00";

typedef struct struct_message {
    char anchorAddr[5];
    float range;
} struct_message;

// ESP-NOW Receive Callback (With Logging restored)
void OnDataRecv(const esp_now_recv_info_t *recv_info, const uint8_t *incomingData, int len) {
    struct_message *incoming = (struct_message *)incomingData;
    String addr = String(incoming->anchorAddr);
    float val = incoming->range;

    if (addr == "1786") r1786 = String(val, 2);
    else if (addr == "1685") r1685 = String(val, 2);
    else if (addr == "1584") r1584 = String(val, 2);

    // LOGGING: See data arriving from Tag
    Serial.print("Bridge Recv -> ");
    Serial.print(addr);
    Serial.print(": ");
    Serial.println(val);
}

class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) { deviceConnected = true; Serial.println("BLE: Connected"); }
  void onDisconnect(BLEServer*) {
    deviceConnected = false;
    Serial.println("BLE: Disconnected");
    BLEDevice::startAdvertising();
  }
};

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  WiFi.mode(WIFI_STA);
  if (esp_now_init() == ESP_OK) {
    esp_now_register_recv_cb((esp_now_recv_cb_t)OnDataRecv);
    Serial.println("ESP-NOW: Initialized");
  }

  Wire.begin(I2C_SDA, I2C_SCL);
  if (bno08x.begin_I2C(0x4A) || bno08x.begin_I2C(0x4B)) {
    Serial.println("IMU: BNO085 Connected!");
    bno08x.enableReport(SH2_GAME_ROTATION_VECTOR, 5000);
    bnoFound = true;
  } else {
    Serial.println("IMU: WARNING - Not found. Pen will have no orientation.");
  }
  
  pinMode(FSR_PIN, INPUT);
  pinMode(BTN_NEW_PAGE, INPUT_PULLUP);

  BLEDevice::init("UWB_SmartStroke_Pen");
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();
  BLEDevice::startAdvertising();
  Serial.println("BLE: Advertising as 'UWB_SmartStroke_Pen'");
}

void loop() {
  bool hasIMU = bnoFound && bno08x.getSensorEvent(&sensorValue);
  
  if (deviceConnected) {
    int fsrReading = analogRead(FSR_PIN);
    int newPage = (digitalRead(BTN_NEW_PAGE) == LOW) ? 1 : 0;
    
    // BUILD JSON
    String json = "{";
    json += "\"links\":[";
    json += "{\"A\":\"1786\",\"R\":\"" + r1786 + "\"},";
    json += "{\"A\":\"1685\",\"R\":\"" + r1685 + "\"},";
    json += "{\"A\":\"1584\",\"R\":\"" + r1584 + "\"}";
    json += "],";
    json += "\"r\":" + String(hasIMU ? sensorValue.un.gameRotationVector.real : 1.0, 4) + ",";
    json += "\"i\":" + String(hasIMU ? sensorValue.un.gameRotationVector.i : 0.0, 4) + ",";
    json += "\"j\":" + String(hasIMU ? sensorValue.un.gameRotationVector.j : 0.0, 4) + ",";
    json += "\"k\":" + String(hasIMU ? sensorValue.un.gameRotationVector.k : 0.0, 4) + ",";
    json += "\"p\":" + String(fsrReading) + ",";
    json += "\"np\":" + String(newPage);
    json += "}";
    
    pCharacteristic->setValue(json.c_str());
    pCharacteristic->notify();
    delay(10); 
  }
}