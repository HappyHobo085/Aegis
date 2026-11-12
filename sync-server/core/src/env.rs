//! What the core needs from its host and cannot get purely: the time and randomness.
//!
//! The core never reads the OS clock or OS entropy itself. A host implements these traits — the
//! native server with `SystemClock` / `OsEntropy` in `sync-server/src/main.rs`, a WASM host with
//! whatever its runtime provides — and tests inject fixed values, which is what makes a contract
//! vector with a signed token reproducible.

/// Wall-clock time in milliseconds since the UNIX epoch.
pub trait Clock {
    fn now_ms(&self) -> i64;
}

/// A source of unpredictable bytes. `fill` must overwrite all of `buf`; a host with no working
/// entropy source should panic rather than return predictable bytes.
pub trait Entropy {
    fn fill(&mut self, buf: &mut [u8]);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(i64);
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    struct Counting(u8);
    impl Entropy for Counting {
        fn fill(&mut self, buf: &mut [u8]) {
            for b in buf {
                *b = self.0;
                self.0 = self.0.wrapping_add(1);
            }
        }
    }

    #[test]
    fn the_traits_are_object_safe_and_injectable() {
        let c: &dyn Clock = &Fixed(42);
        assert_eq!(c.now_ms(), 42);
        let mut e = Counting(7);
        let r: &mut dyn Entropy = &mut e;
        let mut buf = [0u8; 3];
        r.fill(&mut buf);
        assert_eq!(buf, [7, 8, 9]);
    }
}
