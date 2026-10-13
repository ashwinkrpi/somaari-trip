import fs from 'fs';
import path from 'path';

export function ensureSampleData(dataDir: string) {
  if (process.env.SEED_SAMPLE_DATA !== 'true') {
    return; // No-op by default to prevent EROFS on read-only mount
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const existingFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('trips_') && f.endsWith('.csv'));
  if (existingFiles.length > 0) {
    return; // Already has data
  }

  console.log('Generating realistic sample Overland GPS trip data in ./data/...');
  generateSampleDays(dataDir);
}

export function generateSampleDays(dataDir: string) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Base coordinates: Bengaluru, India (around MG Road / Indiranagar / Koramangala)
  // Base Lat: 12.9716, Lon: 77.5946
  // Days: 2026-08-25, 2026-08-26, 2026-08-27, 2026-08-28, 2026-08-29, 2026-08-30

  const dates = [
    '2026-08-25',
    '2026-08-26',
    '2026-08-27',
    '2026-08-28',
    '2026-08-29',
    '2026-08-30',
  ];

  const header = 'timestamp,trip_id,lat,lon,speed_mps,speed_accuracy,course,course_accuracy,altitude_m,vertical_accuracy,accuracy_m,battery_level,battery_state,motion,wifi_ssid,device_id,trip_distance_m,trip_mode,trip_start\n';

  for (let dIdx = 0; dIdx < dates.length; dIdx++) {
    const dateStr = dates[dIdx];
    const rows: string[] = [];

    // Trip 1: Morning Commute (e.g. 08:30 IST -> 03:00 UTC)
    // Mode: Driving / Cycling / Walking depending on day
    const trip1Mode = dIdx % 2 === 0 ? 'driving' : 'cycling';
    const trip1Id = `trip_${dateStr.replace(/-/g, '')}_morning`;
    const trip1StartTime = new Date(`${dateStr}T03:00:00.000Z`).getTime();
    
    let curLat = 12.9352 + (dIdx * 0.002);
    let curLon = 77.6245 + (dIdx * 0.001);
    let dist = 0;
    let battery = 0.95 - (dIdx * 0.02);

    // 25 points for morning commute
    for (let i = 0; i < 25; i++) {
      const time = new Date(trip1StartTime + i * 45 * 1000).toISOString();
      const speed = trip1Mode === 'driving' ? 8.5 + Math.sin(i * 0.5) * 4 : 4.8 + Math.cos(i * 0.3) * 1.5;
      curLat += 0.0008 + (Math.random() * 0.0002 - 0.0001);
      curLon += 0.0006 + (Math.random() * 0.0002 - 0.0001);
      dist += Math.round(speed * 45);
      battery -= 0.001;

      // Stop at a signal midway (points 10, 11, 12, 13)
      const isSignalStop = i >= 10 && i <= 13;
      const pointSpeed = isSignalStop ? 0.0 : +speed.toFixed(2);
      const motion = isSignalStop ? 'stationary' : (trip1Mode === 'driving' ? 'automotive' : 'cycling');
      const accuracy = 5 + Math.round(Math.random() * 8);

      rows.push([
        time,
        trip1Id,
        curLat.toFixed(6),
        curLon.toFixed(6),
        pointSpeed,
        1.0,
        Math.round((i * 12) % 360),
        5.0,
        915 + Math.round(Math.sin(i) * 10),
        3.0,
        accuracy,
        +battery.toFixed(2),
        'unplugged',
        motion,
        i === 0 ? 'Home_Fiber_5G' : (isSignalStop ? 'TrafficSignal_Mesh' : ''),
        'sample-device',
        dist,
        trip1Mode,
        i === 0 ? time : '',
      ].join(','));
    }

    // Mid-day stationary stop at Cafe / Co-working (office) with a deliberate gap (> 5 min)
    // 05:00 UTC (10:30 AM IST)
    const trip2Id = `trip_${dateStr.replace(/-/g, '')}_lunch_walk`;
    const trip2StartTime = new Date(`${dateStr}T06:30:00.000Z`).getTime();
    curLat = 12.9650 + (dIdx * 0.001);
    curLon = 77.6420 + (dIdx * 0.001);
    dist = 0;

    // First leg of lunch walk
    for (let i = 0; i < 8; i++) {
      const time = new Date(trip2StartTime + i * 30 * 1000).toISOString();
      const speed = 1.3 + Math.random() * 0.3;
      curLat += 0.0002;
      curLon += 0.0003;
      dist += Math.round(speed * 30);
      battery -= 0.0005;

      rows.push([
        time,
        trip2Id,
        curLat.toFixed(6),
        curLon.toFixed(6),
        +speed.toFixed(2),
        0.5,
        45,
        3.0,
        920,
        2.0,
        6,
        +battery.toFixed(2),
        'unplugged',
        'walking',
        '',
        'sample-device',
        dist,
        'walking',
        i === 0 ? time : '',
      ].join(','));
    }

    // Stationary stop at Cafe (35 minutes gap + stationary points)
    const cafeStartTime = trip2StartTime + 8 * 30 * 1000 + 1000;
    for (let i = 0; i < 5; i++) {
      const time = new Date(cafeStartTime + i * 60 * 1000).toISOString();
      rows.push([
        time,
        trip2Id,
        curLat.toFixed(6),
        curLon.toFixed(6),
        0.0,
        0.1,
        0,
        0,
        921,
        2.0,
        8,
        +battery.toFixed(2),
        'charging',
        'stationary',
        'ThirdWaveCoffee_Guest',
        'sample-device',
        dist,
        'walking',
        '',
      ].join(','));
    }

    // Walk back (with > 5 min gap to trigger segment splitting!)
    const walkBackStartTime = cafeStartTime + 20 * 60 * 1000; // 20 min gap!
    for (let i = 0; i < 8; i++) {
      const time = new Date(walkBackStartTime + i * 30 * 1000).toISOString();
      const speed = 1.35;
      curLat -= 0.0002;
      curLon -= 0.0003;
      dist += Math.round(speed * 30);

      rows.push([
        time,
        trip2Id,
        curLat.toFixed(6),
        curLon.toFixed(6),
        +speed.toFixed(2),
        0.5,
        225,
        3.0,
        920,
        2.0,
        7,
        +battery.toFixed(2),
        'unplugged',
        'walking',
        i === 7 ? 'Office_Corp_WLAN' : '',
        'sample-device',
        dist,
        'walking',
        '',
      ].join(','));
    }

    // Trip 3: Evening Trip (e.g. 18:30 IST -> 13:00 UTC)
    // Cycling or Running or Driving
    const trip3Mode = dIdx % 3 === 0 ? 'running' : (dIdx % 3 === 1 ? 'cycling' : 'driving');
    const trip3Id = `trip_${dateStr.replace(/-/g, '')}_evening`;
    const trip3StartTime = new Date(`${dateStr}T13:00:00.000Z`).getTime();
    curLat = 12.9650 + (dIdx * 0.001);
    curLon = 77.6420 + (dIdx * 0.001);
    dist = 0;
    const speedBase = trip3Mode === 'running' ? 3.2 : (trip3Mode === 'cycling' ? 5.5 : 10.2);

    for (let i = 0; i < 30; i++) {
      const time = new Date(trip3StartTime + i * 40 * 1000).toISOString();
      const speed = speedBase + Math.sin(i * 0.4) * (speedBase * 0.3);
      // Create a nice loop or trajectory
      curLat += Math.sin(i * 0.2) * 0.001;
      curLon -= Math.cos(i * 0.15) * 0.0009;
      dist += Math.round(speed * 40);
      battery -= 0.0015;

      const isParkStop = (trip3Mode === 'running' || trip3Mode === 'cycling') && (i >= 14 && i <= 17);
      const ptSpeed = isParkStop ? 0.0 : +speed.toFixed(2);
      const motion = isParkStop ? 'stationary' : (trip3Mode === 'running' ? 'running' : (trip3Mode === 'cycling' ? 'cycling' : 'automotive'));

      rows.push([
        time,
        trip3Id,
        curLat.toFixed(6),
        curLon.toFixed(6),
        ptSpeed,
        0.8,
        Math.round((i * 15) % 360),
        4.0,
        910 + Math.round(Math.cos(i) * 15),
        2.5,
        6 + (i % 5),
        +Math.max(0.1, battery).toFixed(2),
        'unplugged',
        motion,
        isParkStop ? 'CubbonPark_FreeWifi' : (i === 29 ? 'Home_Fiber_5G' : ''),
        'sample-device',
        dist,
        trip3Mode,
        i === 0 ? time : '',
      ].join(','));
    }

    const csvContent = header + rows.join('\n') + '\n';
    const filePath = path.join(dataDir, `trips_${dateStr}.csv`);
    fs.writeFileSync(filePath, csvContent, 'utf-8');
  }

  console.log(`Successfully generated ${dates.length} sample trip log files in ${dataDir}`);
}
