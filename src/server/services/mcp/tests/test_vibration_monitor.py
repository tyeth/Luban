"""Hardware-free tests of vibration_monitor.py against a simulated LSM6DSOX and TCA9548A."""

import base64
import importlib.util
from pathlib import Path
import struct
import unittest

SPEC = importlib.util.spec_from_file_location('vibration_monitor', Path(__file__).resolve().parents[1] / 'vibration_monitor.py')
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


class FakeImu:
    """LSM6DSOX register map with a tagged FIFO. `wraps`: burst reads roll back from 7Eh to 78h."""

    def __init__(self, whoami=0x6C, wraps=True, fine=0):
        self.regs = {0x0F: whoami, 0x12: 0x04, 0x18: 0xE0, 0x63: fine & 0xFF}
        self.fifo = []
        self.wraps = wraps
        self.overrun = False
        self.writes = []

    def push(self, tag, x, y, z):
        self.fifo.append(bytes([tag << 3]) + struct.pack('<hhh', x, y, z))

    def write(self, data):
        reg = data[0]
        self.writes.append((reg, data[1]))
        value = data[1]
        if reg == 0x12 and value & 0x01:
            value &= ~0x01  # reset completes at once
        self.regs[reg] = value

    def read(self, reg, buf):
        if reg == 0x3A:
            count = len(self.fifo)
            buf[0] = count & 0xFF
            buf[1] = ((count >> 8) & 0x03) | (0x40 if self.overrun else 0)
            self.overrun = False
            return
        if reg == 0x78:
            out = bytearray()
            while len(out) < len(buf):
                if not self.fifo:
                    out.extend(bytes(7))
                    continue
                word = self.fifo.pop(0)
                if self.wraps or not out:
                    out.extend(word)
                else:
                    # No rollback: the address runs on past 7Eh into other registers.
                    out.extend(bytes([0xFF]) * 7)
            buf[:] = out[:len(buf)]
            return
        for i in range(len(buf)):
            buf[i] = self.regs.get(reg + i, 0)


class FakeI2C:
    def __init__(self, devices, muxes=()):
        self.devices = devices
        self.muxes = {addr: 0 for addr in muxes}
        self.mux_writes = []
        self.locked = False
        self.behind = {}

    def attach_behind(self, mux_addr, channel, addr, device):
        self.behind[(mux_addr, channel, addr)] = device

    def try_lock(self):
        if self.locked:
            return False
        self.locked = True
        return True

    def unlock(self):
        self.locked = False

    def device(self, addr):
        if addr in self.devices:
            return self.devices[addr]
        for mux_addr, mask in self.muxes.items():
            for channel in range(8):
                if mask & (1 << channel) and (mux_addr, channel, addr) in self.behind:
                    return self.behind[(mux_addr, channel, addr)]
        raise OSError('no ACK from 0x%02x' % addr)

    def writeto(self, addr, data):
        assert self.locked
        if addr in self.muxes:
            self.muxes[addr] = data[0]
            self.mux_writes.append((addr, data[0]))
            return
        self.device(addr).write(bytes(data))

    def writeto_then_readfrom(self, addr, out, buf):
        assert self.locked
        self.device(addr).read(out[0], buf)

    def scan(self):
        return sorted(list(self.devices) + list(self.muxes))

    def deinit(self):
        pass


def decode(msg, key='a'):
    raw = base64.b64decode(msg[key])
    return [struct.unpack_from('<hhh', raw, i) for i in range(0, len(raw), 6)]


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.lines = []
        self.saved_emit = monitor.emit
        monitor.emit = self.lines.append
        self.saved_batch = monitor.BATCH_S
        monitor.BATCH_S = 0.0

    def tearDown(self):
        monitor.emit = self.saved_emit
        monitor.BATCH_S = self.saved_batch

    def spec(self, **extra):
        spec = {'id': 'head', 'chip': 'lsm6dsox', 'mode': 'fifo', 'address': 0x6A, 'mux': None, 'rate_hz': 1666, 'range_g': 4, 'gyro': False}
        spec.update(extra)
        return spec

    def test_start_programs_rate_range_and_continuous_fifo(self):
        imu = FakeImu(fine=-10)
        sensor = monitor.FifoSensor(monitor.Bus(FakeI2C({0x6A: imu})), self.spec(), 9)
        sensor.start()
        regs = dict(imu.writes)
        self.assertEqual(regs[0x10], (8 << 4) | (2 << 2))  # 1666 Hz, +-4 g
        self.assertEqual(regs[0x09], 8)  # accel batched at 1666, gyro not
        self.assertEqual(imu.regs[0x0A], 0x06)  # continuous mode last
        self.assertEqual(regs[0x12], 0x44)  # BDU | IF_INC
        self.assertTrue(imu.regs[0x18] & 0x02)
        self.assertAlmostEqual(sensor.odr_actual, 6667 * (1 - 0.015) / 4, places=6)
        self.assertAlmostEqual(sensor.accel_scale, 0.000122)

    def test_wrong_chip_is_refused_with_its_whoami(self):
        sensor = monitor.FifoSensor(monitor.Bus(FakeI2C({0x6A: FakeImu(whoami=0x6A)})), self.spec(), 9)
        with self.assertRaises(RuntimeError) as ctx:
            sensor.start()
        self.assertIn('0x6a', str(ctx.exception))

    def test_poll_streams_accel_words_and_skips_gyro_words_into_their_own_stream(self):
        imu = FakeImu()
        sensor = monitor.FifoSensor(monitor.Bus(FakeI2C({0x6A: imu})), self.spec(gyro=True), 4)
        sensor.start()
        for i in range(10):
            imu.push(0x02, i, -i, 8192)
            imu.push(0x01, 100 + i, 0, -1)
        sensor.poll()
        batches = [line for line in self.lines if line.get('t') == 'batch']
        self.assertEqual(len(batches), 1)
        batch = batches[0]
        self.assertEqual(batch['n'], 10)
        self.assertEqual(decode(batch)[3], (3, -3, 8192))
        self.assertEqual(batch['ng'], 10)
        self.assertEqual(decode(batch, 'g')[2], (102, 0, -1))
        self.assertFalse(batch['ovr'])
        self.assertIn('ts', batch)
        self.assertEqual(sensor.bad_tags, 0)

    def test_overrun_is_flagged_on_the_next_batch(self):
        imu = FakeImu()
        sensor = monitor.FifoSensor(monitor.Bus(FakeI2C({0x6A: imu})), self.spec(), 9)
        sensor.start()
        imu.push(0x02, 1, 2, 3)
        imu.overrun = True
        sensor.poll()
        batch = [line for line in self.lines if line.get('t') == 'batch'][0]
        self.assertTrue(batch['ovr'])
        self.assertEqual(sensor.overruns, 1)

    def test_a_part_without_address_rollback_falls_back_to_one_word_per_read(self):
        imu = FakeImu(wraps=False)
        sensor = monitor.FifoSensor(monitor.Bus(FakeI2C({0x6A: imu})), self.spec(), 9)
        sensor.start()
        for i in range(30):
            imu.push(0x02, i, 0, 0)
        sensor.poll()
        self.assertTrue(sensor.per_word)
        self.assertTrue(any(line.get('t') == 'warn' and 'one word per read' in line['error'] for line in self.lines))
        for i in range(5):
            imu.push(0x02, 50 + i, 0, 0)
        self.lines.clear()
        sensor.poll()
        batch = [line for line in self.lines if line.get('t') == 'batch'][0]
        self.assertEqual([x for x, _, _ in decode(batch)], [50, 51, 52, 53, 54])

    def test_mux_channel_is_selected_before_each_sensor_and_others_closed(self):
        a = FakeImu()
        b = FakeImu()
        i2c = FakeI2C({}, muxes=(0x70, 0x71))
        i2c.attach_behind(0x70, 2, 0x6A, a)
        i2c.attach_behind(0x71, 5, 0x6A, b)
        bus = monitor.Bus(i2c)
        first = monitor.FifoSensor(bus, self.spec(id='tail', mux={'address': 0x70, 'channel': 2}), 9)
        second = monitor.FifoSensor(bus, self.spec(id='chuck', mux={'address': 0x71, 'channel': 5}), 9)
        first.start()
        second.start()
        self.assertIn((0x70, 1 << 2), i2c.mux_writes)
        self.assertIn((0x70, 0), i2c.mux_writes)  # closed before the other mux opened
        self.assertIn((0x71, 1 << 5), i2c.mux_writes)
        self.assertTrue(a.writes and b.writes)

    def test_open_i2c_uses_the_pins_the_devices_answer_on(self):
        class Board:
            board_id = 'qtpy_rp2040'
            SCL = 'GP25'
            SDA = 'GP24'
            SCL1 = 'GP23'
            SDA1 = 'GP22'

        buses = {'GP23': FakeI2C({0x6A: FakeImu()}), 'GP25': FakeI2C({})}

        class Busio:
            @staticmethod
            def I2C(scl, sda, frequency):
                return buses[scl]

        i2c, pins, scans = monitor.open_i2c({'sensors': [self.spec()], 'i2c_hz': 400000}, Board, Busio)
        self.assertIs(i2c, buses['GP23'])
        self.assertEqual(pins, 'SCL1/SDA1')

        class OnlyRoot:
            SCL = 'GP25'
            SDA = 'GP24'

        with self.assertRaises(RuntimeError) as ctx:
            monitor.open_i2c({'sensors': [self.spec()]}, OnlyRoot, Busio)
        self.assertIn('no configured device answered', str(ctx.exception))

    def test_poll_mode_quantises_m_s2_to_g_with_per_sample_offsets(self):
        class Driver:
            acceleration = (0.0, 0.0, 9.80665)
            gyro = (0.0, 0.0, 0.0)

        sensor = monitor.PollSensor(monitor.Bus(FakeI2C({})), self.spec(chip='bno055', mode='poll', rate_hz=100, range_g=4))
        sensor.driver = Driver()
        sensor.state = 'ok'
        sensor.next_due = 0
        sensor.poll()
        batch = [line for line in self.lines if line.get('t') == 'batch'][0]
        x, y, z = decode(batch)[0]
        self.assertEqual((x, y), (0, 0))
        self.assertAlmostEqual(z * batch['as'], 1.0, places=3)
        self.assertEqual(struct.unpack('<I', base64.b64decode(batch['dt']))[0], 0)


if __name__ == '__main__':
    unittest.main()
