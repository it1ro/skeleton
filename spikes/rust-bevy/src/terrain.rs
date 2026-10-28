//! Port of `heightAt` from packages/shared/src/terrain.ts, with mulberry32 (rng.ts) and
//! simplex-noise 4.0.3 `createNoise2D`. f64 everywhere, like JS numbers.

const SPAWN_RADIUS: f64 = 260.0;
const MEADOW_RADIUS: f64 = 160.0;

/// mulberry32 from rng.ts.
fn mulberry32(seed: u32) -> impl FnMut() -> f64 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b79f5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

const GRAD2: [f64; 24] = [
    1., 1., -1., 1., 1., -1., -1., -1., 1., 0., -1., 0., 1., 0., -1., 0., 0., 1., 0., -1., 0., 1.,
    0., -1.,
];

/// simplex-noise `createNoise2D`: same permutation from the same random stream.
struct Noise2 {
    perm: [u8; 512],
    gx: [f64; 512],
    gy: [f64; 512],
}

impl Noise2 {
    fn new(random: &mut impl FnMut() -> f64) -> Self {
        let mut perm = [0u8; 512];
        for i in 0..256 {
            perm[i] = i as u8;
        }
        for i in 0..255 {
            let r = i + (random() * (256 - i) as f64) as usize;
            perm.swap(i, r);
        }
        for i in 256..512 {
            perm[i] = perm[i - 256];
        }
        let gx = perm.map(|v| GRAD2[(v as usize % 12) * 2]);
        let gy = perm.map(|v| GRAD2[(v as usize % 12) * 2 + 1]);
        Self { perm, gx, gy }
    }

    fn get(&self, x: f64, y: f64) -> f64 {
        let f2 = 0.5 * (3f64.sqrt() - 1.0);
        let g2 = (3.0 - 3f64.sqrt()) / 6.0;
        let s = (x + y) * f2;
        let i = (x + s).floor() as i32;
        let j = (y + s).floor() as i32;
        let t = (i + j) as f64 * g2;
        let x0 = x - (i as f64 - t);
        let y0 = y - (j as f64 - t);
        let (i1, j1) = if x0 > y0 { (1, 0) } else { (0, 1) };
        let x1 = x0 - i1 as f64 + g2;
        let y1 = y0 - j1 as f64 + g2;
        let x2 = x0 - 1.0 + 2.0 * g2;
        let y2 = y0 - 1.0 + 2.0 * g2;
        let ii = (i & 255) as usize;
        let jj = (j & 255) as usize;
        let p = &self.perm;
        let corner = |t: f64, gi: usize, x: f64, y: f64| {
            if t < 0.0 {
                return 0.0;
            }
            let t = t * t;
            t * t * (self.gx[gi] * x + self.gy[gi] * y)
        };
        let n0 = corner(0.5 - x0 * x0 - y0 * y0, ii + p[jj] as usize, x0, y0);
        let n1 = corner(
            0.5 - x1 * x1 - y1 * y1,
            ii + i1 + p[jj + j1] as usize,
            x1,
            y1,
        );
        let n2 = corner(0.5 - x2 * x2 - y2 * y2, ii + 1 + p[jj + 1] as usize, x2, y2);
        70.0 * (n0 + n1 + n2)
    }

    fn fbm(&self, x: f64, z: f64, octaves: u32) -> f64 {
        let (mut sum, mut amp, mut freq, mut norm) = (0.0, 1.0, 1.0, 0.0);
        for _ in 0..octaves {
            sum += self.get(x * freq, z * freq) * amp;
            norm += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        sum / norm
    }
}

pub struct Terrain {
    continent: Noise2,
    hill: Noise2,
    ridge: Noise2,
}

impl Terrain {
    pub fn new(seed: u32) -> Self {
        let mut rnd = mulberry32(seed);
        let continent = Noise2::new(&mut rnd);
        let hill = Noise2::new(&mut rnd);
        let ridge = Noise2::new(&mut rnd);
        Self {
            continent,
            hill,
            ridge,
        }
    }

    fn continent(&self, x: f64, z: f64) -> f64 {
        let spawn = (-(x * x + z * z) / (SPAWN_RADIUS * SPAWN_RADIUS)).exp();
        (self.continent.fbm(x / 1100.0, z / 1100.0, 3) * 1.4 + spawn * 0.9 - 0.15).clamp(-1.0, 1.0)
    }

    pub fn height_at(&self, x: f64, z: f64) -> f64 {
        let c = self.continent(x, z);
        let hills = self.hill.fbm(x / 160.0, z / 160.0, 4);
        let ridge = 1.0 - self.ridge.fbm(x / 420.0, z / 420.0, 3).abs();
        let mountain = (c - 0.35).max(0.0) * ridge * ridge * 140.0;
        let land = c.max(0.0);
        let wild = c * 26.0 + 2.0 + hills * (2.0 + land * 9.0) + mountain;
        let calm = (-(x * x + z * z) / (MEADOW_RADIUS * MEADOW_RADIUS)).exp();
        wild * (1.0 - calm) + (6.0 + hills * 4.0) * calm
    }
}

#[cfg(test)]
mod tests {
    use super::Terrain;

    /// From `npx tsx spikes/rust-bevy/tools/heights.ts`.
    const TS: [(u32, f64, f64, f64); 14] = [
        (1337, 0., 0., 6.),
        (1337, 10., -5., 7.783698054870924),
        (1337, 63.5, 12.25, 6.760649003476895),
        (1337, -200., 300., 71.0608171313197),
        (1337, 1000., -750., 8.73291088749806),
        (1337, -3333.3, 4444.4, -9.871233830006751),
        (1337, 5000., 5000., 8.543234460850412),
        (42, 0., 0., 6.),
        (42, 10., -5., 7.922052381526802),
        (42, 63.5, 12.25, 11.911363936173077),
        (42, -200., 300., -1.0046869446246323),
        (42, 1000., -750., -6.102825732143031),
        (42, -3333.3, 4444.4, 10.578838289901752),
        (42, 5000., 5000., -7.726485633387291),
    ];

    #[test]
    fn matches_typescript() {
        for (seed, x, z, want) in TS {
            let got = Terrain::new(seed).height_at(x, z);
            assert!(
                (got - want).abs() < 1e-9,
                "seed {seed} ({x}, {z}): {got} != {want}"
            );
        }
    }
}
