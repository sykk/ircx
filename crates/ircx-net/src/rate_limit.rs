use std::time::Duration;

use tokio::time::{sleep_until, Instant};

/// Outbound pacing. A burst is what a client may send on arrival before the
/// server starts counting it as flooding; `interval` is how fast the allowance
/// comes back after that.
#[derive(Debug, Clone, Copy)]
pub struct RateLimit {
    pub burst: u32,
    pub interval: Duration,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            burst: 5,
            interval: Duration::from_millis(500),
        }
    }
}

pub(crate) struct TokenBucket {
    capacity: u32,
    interval: Duration,
    tokens: u32,
    refilled_at: Instant,
}

impl TokenBucket {
    pub(crate) fn new(limit: RateLimit) -> Self {
        // A zero capacity would park the writer forever.
        let capacity = limit.burst.max(1);
        Self {
            capacity,
            interval: limit.interval,
            tokens: capacity,
            refilled_at: Instant::now(),
        }
    }

    pub(crate) async fn acquire(&mut self) {
        loop {
            self.refill(Instant::now());
            if self.tokens > 0 {
                self.tokens -= 1;
                return;
            }
            sleep_until(self.refilled_at + self.interval).await;
        }
    }

    fn refill(&mut self, now: Instant) {
        if self.interval.is_zero() || self.tokens >= self.capacity {
            self.tokens = self.capacity;
            self.refilled_at = now;
            return;
        }
        let elapsed = now.saturating_duration_since(self.refilled_at);
        let gained =
            u32::try_from(elapsed.as_nanos() / self.interval.as_nanos()).unwrap_or(u32::MAX);
        if gained == 0 {
            return;
        }
        self.tokens = self.capacity.min(self.tokens.saturating_add(gained));
        self.refilled_at = if self.tokens == self.capacity {
            now
        } else {
            self.refilled_at + self.interval.saturating_mul(gained)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn spends_the_burst_without_waiting() {
        let mut bucket = TokenBucket::new(RateLimit::default());
        let start = Instant::now();
        for _ in 0..5 {
            bucket.acquire().await;
        }
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn paces_once_the_burst_is_spent() {
        let mut bucket = TokenBucket::new(RateLimit::default());
        let start = Instant::now();
        for _ in 0..9 {
            bucket.acquire().await;
        }
        assert_eq!(start.elapsed(), Duration::from_millis(2000));
    }

    #[tokio::test(start_paused = true)]
    async fn regains_one_token_per_interval_while_idle() {
        let mut bucket = TokenBucket::new(RateLimit::default());
        for _ in 0..5 {
            bucket.acquire().await;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;

        let start = Instant::now();
        for _ in 0..3 {
            bucket.acquire().await;
        }
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_bank_more_than_the_burst() {
        let mut bucket = TokenBucket::new(RateLimit::default());
        tokio::time::sleep(Duration::from_secs(60)).await;

        let start = Instant::now();
        for _ in 0..6 {
            bucket.acquire().await;
        }
        assert_eq!(start.elapsed(), Duration::from_millis(500));
    }
}
