use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::Duration;

use tokio::time::Instant;

#[derive(Debug, Clone, Copy)]
pub struct BackoffPolicy {
    pub initial: Duration,
    pub max: Duration,
    /// How long a connection has to stay up before the next drop is treated as
    /// the first one again.
    pub reset_after: Duration,
    /// Fraction of the delay the jitter may add or subtract, in `0.0..=1.0`.
    pub jitter: f64,
}

impl Default for BackoffPolicy {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(300),
            reset_after: Duration::from_secs(60),
            jitter: 0.2,
        }
    }
}

/// Reconnect timing: the caller reports connects and disconnects, this hands
/// back how long to wait before trying again.
pub struct Backoff {
    policy: BackoffPolicy,
    jitter: Box<dyn FnMut() -> f64 + Send>,
    attempt: u32,
    connected_at: Option<Instant>,
}

impl Backoff {
    pub fn new(policy: BackoffPolicy) -> Self {
        Self::with_jitter(policy, random_unit())
    }

    /// Same as `new` with the randomness supplied by the caller. The source
    /// returns a value in `0.0..=1.0`; 0.5 is the unjittered delay.
    pub fn with_jitter(
        policy: BackoffPolicy,
        jitter: impl FnMut() -> f64 + Send + 'static,
    ) -> Self {
        Self {
            policy,
            jitter: Box::new(jitter),
            attempt: 0,
            connected_at: None,
        }
    }

    pub fn record_connected(&mut self) {
        self.connected_at = Some(Instant::now());
    }

    /// How long to wait before the next attempt. Each call advances the
    /// sequence, so call it once per attempt.
    pub fn next_delay(&mut self) -> Duration {
        if let Some(since) = self.connected_at.take() {
            if since.elapsed() >= self.policy.reset_after {
                self.attempt = 0;
            }
        }

        let doublings = self.attempt.min(31);
        let base = self
            .policy
            .initial
            .saturating_mul(1u32 << doublings)
            .min(self.policy.max);
        self.attempt = self.attempt.saturating_add(1);

        let spread = self.policy.jitter.clamp(0.0, 1.0);
        let sample = (self.jitter)().clamp(0.0, 1.0);
        base.mul_f64(1.0 + spread * (2.0 * sample - 1.0))
    }
}

fn random_unit() -> impl FnMut() -> f64 + Send {
    // The hasher's keys are the only per-process randomness in std.
    let mut state = RandomState::new().build_hasher().finish() | 1;
    move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unjittered(policy: BackoffPolicy) -> Backoff {
        Backoff::with_jitter(policy, || 0.5)
    }

    fn secs(backoff: &mut Backoff, count: usize) -> Vec<u64> {
        (0..count).map(|_| backoff.next_delay().as_secs()).collect()
    }

    #[test]
    fn doubles_up_to_the_ceiling() {
        let mut backoff = unjittered(BackoffPolicy::default());
        assert_eq!(
            secs(&mut backoff, 11),
            vec![1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]
        );
    }

    #[test]
    fn jitter_spreads_the_delay_around_the_base() {
        let policy = BackoffPolicy::default();
        assert_eq!(
            Backoff::with_jitter(policy, || 0.0).next_delay(),
            Duration::from_millis(800)
        );
        assert_eq!(
            Backoff::with_jitter(policy, || 1.0).next_delay(),
            Duration::from_millis(1200)
        );
    }

    #[test]
    fn a_jitter_source_out_of_range_cannot_push_the_delay_past_the_band() {
        let policy = BackoffPolicy::default();
        assert_eq!(
            Backoff::with_jitter(policy, || -5.0).next_delay(),
            Duration::from_millis(800)
        );
        assert_eq!(
            Backoff::with_jitter(policy, || 5.0).next_delay(),
            Duration::from_millis(1200)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_that_stayed_up_resets_the_sequence() {
        let mut backoff = unjittered(BackoffPolicy::default());
        assert_eq!(secs(&mut backoff, 3), vec![1, 2, 4]);

        backoff.record_connected();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(secs(&mut backoff, 2), vec![1, 2]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_that_dropped_early_keeps_climbing() {
        let mut backoff = unjittered(BackoffPolicy::default());
        assert_eq!(secs(&mut backoff, 3), vec![1, 2, 4]);

        backoff.record_connected();
        tokio::time::sleep(Duration::from_secs(59)).await;
        assert_eq!(secs(&mut backoff, 1), vec![8]);
    }

    #[test]
    fn the_default_jitter_source_stays_inside_the_band() {
        let mut backoff = Backoff::new(BackoffPolicy::default());
        for _ in 0..100 {
            let delay = backoff.next_delay();
            assert!(delay >= Duration::from_millis(800), "{delay:?}");
            assert!(delay <= Duration::from_secs(360), "{delay:?}");
        }
    }
}
