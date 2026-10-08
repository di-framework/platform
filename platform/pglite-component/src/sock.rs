//! Minimal poll-driven TCP client over `wasi:sockets`.
//!
//! The provider world is synchronous, so this shim turns the non-blocking
//! socket API into `connect` / `read_exact` / `write_all` with explicit
//! `subscribe`/`block` waits. No async runtime. (The blocking stream
//! helpers are avoided: they misbehave on the dev host.)

use crate::wasi::io::streams::{InputStream, OutputStream, StreamError};
use crate::wasi::sockets::instance_network::instance_network;
use crate::wasi::sockets::ip_name_lookup::resolve_addresses;
use crate::wasi::sockets::network::{
    ErrorCode, IpAddress, IpSocketAddress, Ipv4SocketAddress, Ipv6SocketAddress, Network,
};
use crate::wasi::sockets::tcp::TcpSocket;
use crate::wasi::sockets::tcp_create_socket::create_tcp_socket;

pub struct Sock {
    input: InputStream,
    output: OutputStream,
    // The streams are children of the socket, which may itself be tied to
    // the network handle in the host's resource table: both stay alive for
    // the session, declared last so they drop after the streams.
    _socket: TcpSocket,
    _network: Network,
}

fn sock_err(code: &ErrorCode) -> String {
    format!("socket error: {code:?}")
}

fn resolve(net: &Network, host: &str) -> Result<IpAddress, String> {
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        let [a, b, c, d] = v4.octets();
        return Ok(IpAddress::Ipv4((a, b, c, d)));
    }
    if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        let [a, b, c, d, e, f, g, h] = v6.segments();
        return Ok(IpAddress::Ipv6((a, b, c, d, e, f, g, h)));
    }
    let stream = resolve_addresses(net, host).map_err(|e| format!("dns lookup failed: {e:?}"))?;
    match stream.resolve_next_address().map_err(|e| sock_err(&e))? {
        Some(addr) => Ok(addr),
        None => Err(format!("dns lookup returned no address for {host}")),
    }
}

pub fn connect(host: &str, port: u16) -> Result<Sock, String> {
    use crate::wasi::sockets::network::IpAddressFamily;

    let net = instance_network();
    let ip = resolve(&net, host)?;
    let family = match ip {
        IpAddress::Ipv4(_) => IpAddressFamily::Ipv4,
        IpAddress::Ipv6(_) => IpAddressFamily::Ipv6,
    };
    let sock = create_tcp_socket(family).map_err(|e| sock_err(&e))?;
    let remote = match ip {
        IpAddress::Ipv4(address) => IpSocketAddress::Ipv4(Ipv4SocketAddress { port, address }),
        IpAddress::Ipv6(address) => IpSocketAddress::Ipv6(Ipv6SocketAddress {
            port,
            address,
            flow_info: 0,
            scope_id: 0,
        }),
    };
    sock.start_connect(&net, remote).map_err(|e| sock_err(&e))?;

    let pollable = sock.subscribe();

    loop {
        match sock.finish_connect() {
            Ok((input, output)) => {
                return Ok(Sock {
                    input,
                    output,
                    _socket: sock,
                    _network: net,
                });
            }
            Err(ErrorCode::WouldBlock) => {
                pollable.block();
            }
            Err(e) => return Err(sock_err(&e)),
        }
    }
}

impl Sock {
    /// Read exactly `out.len()` bytes, waiting with `subscribe`/`block`
    /// between frames (the same poll loop `wstd` uses for HTTP bodies --
    /// the blocking stream helpers are unreliable on this host).
    pub fn read_exact(&self, mut out: &mut [u8]) -> Result<(), String> {
        while !out.is_empty() {
            let want = u64::try_from(out.len()).unwrap_or(u64::MAX);
            match self.input.read(want) {
                Ok(chunk) if !chunk.is_empty() => {
                    let n = chunk.len().min(out.len());
                    let (head, tail) = out.split_at_mut(n);
                    let src = chunk
                        .get(..n)
                        .ok_or_else(|| "short read chunk".to_string())?;
                    head.copy_from_slice(src);
                    out = tail;
                }
                Ok(_) => self.input.subscribe().block(),
                Err(StreamError::Closed) => {
                    return Err("connection closed by server".to_string());
                }
                Err(e) => return Err(format!("read failed: {e:?}")),
            }
        }
        Ok(())
    }

    /// Write the whole buffer: take capacity from `check-write`, wait on
    /// `subscribe` when zero, then flush.
    pub fn write_all(&self, mut buf: &[u8]) -> Result<(), String> {
        while !buf.is_empty() {
            let capacity = self
                .output
                .check_write()
                .map_err(|e| format!("check-write failed: {e:?}"))?;

            if capacity == 0 {
                self.output.subscribe().block();
                continue;
            }
            let take = buf
                .len()
                .min(usize::try_from(capacity).unwrap_or(usize::MAX));
            let head = buf
                .get(..take)
                .ok_or_else(|| "write range out of bounds".to_string())?;
            self.output
                .write(head)
                .map_err(|e| format!("write failed: {e:?}"))?;

            buf = buf
                .get(take..)
                .ok_or_else(|| "write range out of bounds".to_string())?;
        }

        self.output
            .flush()
            .map_err(|e| format!("flush failed: {e:?}"))?;

        Ok(())
    }
}
