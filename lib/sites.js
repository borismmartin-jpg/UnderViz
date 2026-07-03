// UnderViz — seed site list (Perth / Rottnest / WA).
// Plain data, easy to extend. Each site:
//   name            display name
//   lat, lon        [deg] (negative lat = south)
//   depth_default   typical dive depth [m] (user-adjustable in UI)
//   c0              baseline beam attenuation [m^-1] (oceanic ~0.15 -> ~30 m ceiling;
//                   metro inshore ~0.3–0.5)
//   u_crit          critical resuspension velocity [m s^-1] (~0.08–0.15)
//   E               erodibility [index h^-1 (m/s)^-1.5] (silt > sand > rocky reef)
//   w_s             settling velocity [m s^-1] (~0.0001 fine silt … 0.0005 coarse)
//   fetch           open-water distance by 8 compass sectors [km]
//                   (direction the wind comes FROM; land/offshore wind -> ~0)
//   runoff_r        runoff exposure [index h^-1 per mm h^-1 rain]
//                   (0 offshore/oceanic; high river-mouth/urban-drain)
//   notes           short description shown in the UI

export const SEED_SITES = [
  {
    id: 'mettams',
    name: 'Mettams Pool',
    lat: -31.8622, lon: 115.7546,
    depth_default: 3,
    c0: 0.35, u_crit: 0.10, E: 1.0, w_s: 0.0002,
    fetch: { N: 40, NE: 1, E: 1, SE: 1, S: 30, SW: 350, W: 500, NW: 300 },
    runoff_r: 0.02,
    notes: 'Shallow sheltered reef pool, North Beach. Sandy patches stir easily.',
  },
  {
    id: 'north-mole',
    name: 'North Mole',
    lat: -32.0553, lon: 115.7350,
    depth_default: 6,
    c0: 0.40, u_crit: 0.08, E: 1.2, w_s: 0.0001,
    fetch: { N: 30, NE: 1, E: 1, SE: 5, S: 60, SW: 400, W: 500, NW: 300 },
    runoff_r: 0.15,
    notes: 'Swan River mouth, Fremantle. High runoff exposure after rain.',
  },
  {
    id: 'rotto-west-end',
    name: 'Rottnest West End (Cape Vlamingh)',
    lat: -32.0230, lon: 115.4490,
    depth_default: 18,
    c0: 0.16, u_crit: 0.13, E: 0.3, w_s: 0.0004,
    fetch: { N: 300, NE: 15, E: 10, SE: 100, S: 400, SW: 500, W: 500, NW: 500 },
    runoff_r: 0,
    notes: 'Deep oceanic limestone reef, fully exposed to Indian Ocean swell.',
  },
  {
    id: 'salmon-bay',
    name: 'Salmon Bay (Rottnest)',
    lat: -32.0260, lon: 115.5450,
    depth_default: 6,
    c0: 0.20, u_crit: 0.12, E: 0.5, w_s: 0.0003,
    fetch: { N: 1, NE: 1, E: 40, SE: 250, S: 500, SW: 450, W: 60, NW: 1 },
    runoff_r: 0,
    notes: 'Rottnest south side. Sheltered from NW; open to southerly swell.',
  },
  {
    id: 'little-island',
    name: 'Little Island',
    lat: -31.7750, lon: 115.7180,
    depth_default: 5,
    c0: 0.30, u_crit: 0.11, E: 0.8, w_s: 0.00025,
    fetch: { N: 150, NE: 2, E: 2, SE: 2, S: 60, SW: 400, W: 500, NW: 350 },
    runoff_r: 0.01,
    notes: 'Marmion Marine Park. Shallow reef, popular freedive spot.',
  },
  {
    id: 'three-mile',
    name: 'Three Mile Reef',
    lat: -31.8000, lon: 115.6800,
    depth_default: 10,
    c0: 0.25, u_crit: 0.12, E: 0.6, w_s: 0.0003,
    fetch: { N: 200, NE: 20, E: 8, SE: 20, S: 150, SW: 450, W: 500, NW: 400 },
    runoff_r: 0.005,
    notes: 'Offshore limestone lumps ~5 km out from Hillarys.',
  },
  {
    id: 'wedge-inshore',
    name: 'Wedge Island — inshore',
    lat: -30.8420, lon: 115.1650,
    depth_default: 3.5,
    c0: 0.22, u_crit: 0.10, E: 0.9, w_s: 0.00025,
    // Coast runs NNW-SSE; land to the E, open Indian Ocean W/SW/NW. The outer
    // reef lines knock down some swell but the lagoon sand stirs easily.
    fetch: { N: 200, NE: 2, E: 1, SE: 2, S: 120, SW: 450, W: 500, NW: 500 },
    runoff_r: 0,
    notes: 'Turquoise Coast lagoon behind the outer reef. Sand stirs in swell.',
  },
  {
    id: 'wedge-offshore',
    name: 'Wedge Island — offshore reef',
    lat: -30.8350, lon: 115.1350,
    depth_default: 12,
    c0: 0.17, u_crit: 0.13, E: 0.4, w_s: 0.00035,
    fetch: { N: 300, NE: 5, E: 2, SE: 5, S: 200, SW: 500, W: 500, NW: 500 },
    runoff_r: 0,
    notes: 'Limestone lumps west of the island, fully exposed. Clear when settled.',
  },
  {
    id: 'abrolhos',
    name: 'Abrolhos Islands (placeholder)',
    lat: -28.7200, lon: 113.7800,
    depth_default: 15,
    c0: 0.15, u_crit: 0.13, E: 0.3, w_s: 0.0004,
    fetch: { N: 500, NE: 60, E: 60, SE: 200, S: 500, SW: 500, W: 500, NW: 500 },
    runoff_r: 0,
    notes: 'Oceanic placeholder — refine per-island parameters before trusting.',
  },
];

// Presets used by the "add custom site" form (bottom type -> sediment params).
export const BOTTOM_PRESETS = {
  silt: { E: 1.2, u_crit: 0.08, w_s: 0.0001, label: 'Silt / mud (stirs easily, settles slowly)' },
  sand: { E: 1.0, u_crit: 0.10, w_s: 0.00025, label: 'Sand (moderate)' },
  reef: { E: 0.3, u_crit: 0.13, w_s: 0.0004, label: 'Rocky reef (little loose sediment)' },
};

// Default fetch table for new custom sites: typical Perth metro west coast.
export const DEFAULT_FETCH = { N: 50, NE: 1, E: 1, SE: 1, S: 50, SW: 400, W: 500, NW: 300 };
