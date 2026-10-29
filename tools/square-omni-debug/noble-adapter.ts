/**
 * Minimal Web Bluetooth surface (the parts src/game/square-omni.js uses) on top of @stoprocent/noble,
 * so the game's browser session code runs unchanged in a terminal.
 *
 * Why not the `webbluetooth` npm package: its bundled SimpleBLE (v0.6.1) overflows a fixed-size
 * buffer when a nearby device advertises long manufacturer data, and aborts the process on macOS.
 */
import noble from "@stoprocent/noble";

const SQUARE_SERVICE = "86601001" + "6b7e439abdd1489a3213e9bb";
const short = (uuid: string) => uuid.replace(/-/g, "").toLowerCase();
const toDataView = (buf: Uint8Array) => new DataView(Uint8Array.from(buf).buffer);

export type Seen = { name: string; id: string; rssi: number; manufacturerData?: Uint8Array };

/**
 * Scan until a device whose advertised name starts with `namePrefix` appears.
 *
 * Duplicates must be allowed: the Omni's name arrives in its scan response, not its first advertising
 * packet. Without duplicates macOS reports each device once, usually on that nameless first packet,
 * and never tells us the name. (bleak, which found the Omni instantly, scans with duplicates on too.)
 */
export async function findDevice(namePrefix: string, timeoutMs: number, onSeen?: (d: Seen) => void): Promise<WebBluetoothDevice> {
  await noble.waitForPoweredOnAsync(10_000).catch(() => {
    throw new Error(`Bluetooth adapter is not ready (state: ${noble.state}). On macOS, "unauthorized" means your terminal app lacks Bluetooth permission.`);
  });
  const nearby = new Map<string, { name: string; rssi: number }>();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = async () => {
      done = true;
      clearTimeout(timer);
      noble.removeListener("discover", onDiscover);
      await noble.stopScanningAsync().catch(() => {});
    };
    const onDiscover = async (p: any) => {
      if (done) return;
      const name: string = p.advertisement?.localName ?? "";
      const known = nearby.get(p.id);
      if (!known || (name && !known.name)) nearby.set(p.id, { name: name || known?.name || "", rssi: p.rssi });
      const isOmni = name.startsWith(namePrefix) || (p.advertisement?.serviceUuids ?? []).includes(SQUARE_SERVICE);
      if (!isOmni) return;
      await finish();
      onSeen?.({ name: name || namePrefix, id: p.id, rssi: p.rssi, manufacturerData: p.advertisement?.manufacturerData });
      await new Promise((r) => setTimeout(r, 250)); // settle after stopping the scan (allsquare SEQUENCE.md §2)
      resolve(new WebBluetoothDevice(p));
    };
    const timer = setTimeout(async () => {
      await finish();
      const list = [...nearby.values()].sort((a, b) => b.rssi - a.rssi);
      const named = list.filter((d) => d.name).slice(0, 12).map((d) => `${d.name} (${d.rssi} dBm)`);
      reject(new Error(`no device named ${namePrefix}(…) found within ${timeoutMs / 1000} s. ` +
        `Saw ${list.length} device(s), ${list.filter((d) => d.name).length} with names` + (named.length ? `: ${named.join(", ")}` : "")));
    }, timeoutMs);
    noble.on("discover", onDiscover);
    noble.startScanningAsync([], true).catch(reject);
  });
}

class WebBluetoothDevice extends EventTarget {
  readonly name: string;
  readonly id: string;
  readonly gatt: Gatt;
  constructor(peripheral: any) {
    super();
    this.name = peripheral.advertisement?.localName || "SquareGolf";
    this.id = peripheral.id;
    this.gatt = new Gatt(peripheral);
    peripheral.on("disconnect", () => {
      this.gatt.connected = false;
      this.dispatchEvent(new Event("gattserverdisconnected"));
    });
  }
}

class Gatt {
  connected = false;
  constructor(private peripheral: any) {}
  async connect() {
    await this.peripheral.connectAsync();
    this.connected = true;
    return new Server(this.peripheral);
  }
  disconnect() {
    this.peripheral.disconnectAsync().catch(() => {});
  }
}

class Server {
  constructor(private peripheral: any) {}
  async getPrimaryService(uuid: string) {
    const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync([short(uuid)], []);
    if (!characteristics.length) throw new Error("Square Golf service not found");
    return new Service(characteristics);
  }
}

class Service {
  private cache = new Map<string, Characteristic>();
  constructor(private characteristics: any[]) {}
  async getCharacteristic(uuid: string) {
    const key = short(uuid);
    if (!this.cache.has(key)) {
      const c = this.characteristics.find((x) => x.uuid === key);
      if (!c) throw new Error(`characteristic ${uuid} not found`);
      this.cache.set(key, new Characteristic(c));
    }
    return this.cache.get(key)!;
  }
}

class Characteristic extends EventTarget {
  value: DataView | null = null;
  private subscribed = false;
  constructor(private c: any) { super(); }
  async readValue() { return toDataView(await this.c.readAsync()); }
  async writeValueWithResponse(bytes: Uint8Array) { await this.c.writeAsync(Buffer.from(bytes), false); }
  async writeValue(bytes: Uint8Array) { await this.c.writeAsync(Buffer.from(bytes), false); }
  async startNotifications() {
    if (!this.subscribed) {
      this.subscribed = true;
      this.c.on("data", (data: Buffer) => {
        this.value = toDataView(data);
        this.dispatchEvent(new Event("characteristicvaluechanged"));
      });
    }
    await this.c.subscribeAsync();
    return this;
  }
}
