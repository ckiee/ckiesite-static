# An Adventure Through Tailscale and CoreDNS 

## prologue

recently, i've been using my beefier [desktop machine](https://github.com/ckiee/nixfiles/blob/ebc09474dd7b005c8e19e9188db2123e4a5d7081/README.md#cookiemonster) remotely to conserve battery when coding on my laptop while i'm at school.

this works pretty well most of the time (i have another host's sshd port-forwarded to [WoL](https://en.wikipedia.org/wiki/Wake-on-LAN) the machine) but trying to swoosh ssh into [reverse-]forwarding the right ports to test stuff gets painful rather quickly when using [tooling that](https://github.com/DBCDK/morph) [runs ssh](https://nixos.org/manual/nix/unstable/command-ref/new-cli/nix3-copy.html) for you.

## Tailscale

[Tailscale](https://tailscale.com) is a nice overlay VPN backed by WireGuard; basically you login into tailscale on a bunch of machines and they get assigned private IPv4s. apparently it's [supposed to break through NATs](https://tailscale.com/blog/how-nat-traversal-works/) but i haven't had any luck with that.

i have a friend who works at tailscale which has made me quite aware of it's existence. i've been carefully avoiding getting a VPN setup [for 4 months](https://github.com/ckiee/nixfiles/commit/b33a40f), but a few weeks of constantly rereading the `ssh(1)` manpage for the various port forwarding argument syntaxes did it for me.

being a NixOS user, i dropped a quick `services.tailscale.enable = true;` on my local machine's configuration, rebuilt, ran `tailscale up` and logged in.

`tailscaled` was happily churning along in the background, so i proceeded to think about running `tailscale up` 3 more times for my other hosts, got terrified at the proposition and wrote [this](https://github.com/ckiee/nixfiles/blob/ebc09474dd7b005c8e19e9188db2123e4a5d7081/modules/services/tailscale.nix) instead:

```nix
    cookie.secrets.tailscale-authkey = {
      source = "./secrets/tailscale-authkey";
      owner = "root";
      group = "root";
      permissions = "0400";
      wantedBy = "tailscaled-autoconfig.service";
    };

    systemd.services.tailscaled-autoconfig = rec {
      description = "Autoconfigure tailscaled";
      wantedBy = [ "multi-user.target" ];
      requires = [ "tailscaled.service" "tailscale-authkey-key.service" ];
      after = requires;

      serviceConfig.Type = "oneshot";

# tailscale has auth keys, which are just little tokens used to automate logging in.
      script =
        "${tailscale}/bin/tailscale up --reset --force-reauth --authkey $(cat ${
          escapeShellArg config.cookie.secrets.tailscale-authkey.dest
        })";
    };
  };
```

after encrypting the new `tailscale-authkey` secret it happily deployed, which meant it was time for my next problem...

```
ckie@cookiemonster ~ -> tailscale status
100.77.146.21   cookiemonster        ckiee@       linux   -
100.124.234.25  bokkusu              ckiee@       linux   -
100.80.1.116    drapion              ckiee@       linux   -
100.94.232.88   galaxy-a51           ckiee@       android active; direct 192.168.0.43:35862, tx 8463276 rx 642228
100.89.163.81   thonkcookie          ckiee@       linux   -
```

(sidenote: i'm still not sure how i feel about depending on yet another company, but i can always fall back on other solutions.)

## DNS troubles

on my home network, i have a [CoreDNS](https://coredns.io/) server listening locally, filtering ads and forwarding other traffic to [`cloudflared`](https://github.com/cloudflare/cloudflared) which (among other things) sends queries using DNS-over-HTTPS.
this has worked pretty well for a while but with the addition of non-local devices, keeping a single host serving two different continents seems like a latency disaster, so i refactored a tad and enabled the [coredns module](https://github.com/ckiee/nixfiles/blob/dd69f55613cd3e64687a99426dfac926f526a6c4/modules/services/coredns/default.nix) on all tailscale-connected hosts.

### MagicDNS

`tailscaled` can also act as a DNS resolver to resolve requests like `<host>.example.com.beta.tailscale.net`; it's supposed to [autoconfigure this](https://tailscale.com/blog/sisyphean-dns-client-linux/) but that didn't work, feels a bit intrusive and doesn't really work with the rest of my setup as i want to keep ad-blocking consistently working.

having too much free time, i sat down and whipped up a little script to occasionally regenerate my hosts file with the currently available tailscale hosts:

```nix
  baseHosts = pkgs.writeTextFile {
    name = "coredns-hosts-ckie";
    text = ''
      # StevenBlack ad-blocking hosts
      ${extHosts}
      # Runtime hosts
    '';
  };
```

```sh
#!@bash@/bin/sh
## shellcheck & shfmt please

BASE_HOSTS="@baseHosts@"
export PATH="$PATH:@tailscale@/bin:@jq@/bin"

while true; do
	newhosts=$(mktemp)
	cat "$BASE_HOSTS" >"$newhosts"
	tailscale status --json | jq -r '([.Peer[]] + [.Self])[] | [.TailAddr, (.HostName | split(" ") | join("-") | ascii_downcase) + "@hostSuffix@"] | @tsv' >> "$newhosts"
    # we do this little dance to try to ensure coredns doesn't reload while
    # we're still writing to the file.
	rm /run/coredns-hosts
	mv "$newhosts" /run/coredns-hosts
	sleep 10
done
```

..sprinkling in some glue:

```nix
      systemd.services.dns-hosts-poller = {
      # [cut]
        serviceConfig = {
          Type = "simple";
          ExecStart = pkgs.runCommandLocal "dns-hosts-poller" {
            inherit (pkgs) bash tailscale jq;
            inherit baseHosts hostSuffix;
          } ''
            substituteAll "${./dns-hosts-poller}" "$out"
            chmod +x "$out"
          '';
        };
      # [cut]
      };
```

making sure CoreDNS actually [re]loads `/run/coredns-hosts`:

```nix
. {
    hosts /run/coredns-hosts {
        reload 1500ms
        fallthrough
    }
    forward . 127.0.0.1:1483
    errors
    cache 120 # two minutes
}
```

..and done! except not, no queries for ad servers get blocked, and nothing is getting resolved:
```sh
ckie@cookiemonster ~/git/nixfiles -> host cookiemonster.tailnet.ckie.dev localhost
Using domain server:
Name: localhost
Address: ::1#53
Aliases:

Host cookiemonster.tailnet.ckie.dev not found: 3(NXDOMAIN)
```

Let's prod at what CoreDNS is reading: (those domains there are probably bad, don't visit!)

```sh
ckie@cookiemonster ~/git/nixfiles -> tail -n20 /run/coredns-hosts
tail: cannot open '/run/coredns-hosts' for reading: Permission denied
ckie@cookiemonster ~/git/nixfiles -> sudo tail -n20 /run/coredns-hosts
0.0.0.0 zukxd6fkxqn.com
0.0.0.0 zy16eoat1w.com

# End yoyo.org

# blacklist
#
# The contents of this file (containing a listing of additional domains in
# 'hosts' file format) are appended to the unified hosts file during the
# update process. For example, uncomment the following line to block
# 'example.com':

# 0.0.0.0 example.com

# Runtime hosts
100.94.232.88   galaxy-a51.tailnet.ckie.dev
100.80.1.116    drapion.tailnet.ckie.dev
100.89.163.81   thonkcookie.tailnet.ckie.dev
100.124.234.25  bokkusu.tailnet.ckie.dev
100.77.146.21   cookiemonster.tailnet.ckie.dev
```

...

...

*Ooooohhhh!* CoreDNS might not be running as root, so it can't open that file, like how I couldn't initially.
```
ckie@cookiemonster ~/git/nixfiles -> cat /etc/systemd/system/coredns.service | grep -i user
DynamicUser=true
```

yup!

```sh
# [cut]
	tailscale status --json | jq -r '([.Peer[]] + [.Self])[] | [.TailAddr, (.HostName | split(" ") | join("-") | ascii_downcase) + "@hostSuffix@"] | @tsv' >> "$newhosts"
    chmod 444 "$newhosts" # ..here we go!
	mv "$newhosts" /run/coredns-hosts
# [cut]
```

let's try it:
```
ckie@cookiemonster ~/git/nixfiles -> host cookiemonster.tailnet.ckie.dev localhost
Using domain server:
Name: localhost
Address: 127.0.0.1#53
Aliases:

Host cookiemonster.tailnet.ckie.dev not found: 3(NXDOMAIN)
ckie@cookiemonster ~/git/nixfiles -> make debug
mo deploy morph.nix switch --passwd --on=cookiemonster*
Selected 1/5 hosts (name filter:-4, limits:-0):
      0: cookiemonster (secrets: 0, health checks: 0, tags: )

these 6 derivations will be built:
  /nix/store/s9ra8a3mh13z44nxh3la2li0s9j5q1q2-dns-hosts-poller.drv
  /nix/store/05hpppgrh8rdrs2pxgvcvdxdy6qfr7vf-unit-dns-hosts-poller.service.drv
  /nix/store/f1j3s0pk8cgh1gfnl90ldzl2qsi0dayr-system-units.drv
  /nix/store/8bs3pdrv5j957mza8ng2cka8fndvgmwa-etc.drv
  /nix/store/ycirn33cr7hpa0xz90yz8asck9b87izb-nixos-system-cookiemonster-21.11pre-git.drv
  /nix/store/ylfkk8gnzg8v0qvbqqvvm71q0q2aymmd-morph.drv
building '/nix/store/s9ra8a3mh13z44nxh3la2li0s9j5q1q2-dns-hosts-poller.drv'...
building '/nix/store/05hpppgrh8rdrs2pxgvcvdxdy6qfr7vf-unit-dns-hosts-poller.service.drv'...
building '/nix/store/f1j3s0pk8cgh1gfnl90ldzl2qsi0dayr-system-units.drv'...
building '/nix/store/8bs3pdrv5j957mza8ng2cka8fndvgmwa-etc.drv'...
building '/nix/store/ycirn33cr7hpa0xz90yz8asck9b87izb-nixos-system-cookiemonster-21.11pre-git.drv'...
building '/nix/store/ylfkk8gnzg8v0qvbqqvvm71q0q2aymmd-morph.drv'...
/nix/store/0md4gfhcnhlr15azh2ymcmjdm4ldg2nw-morph
nix result path:
/nix/store/0md4gfhcnhlr15azh2ymcmjdm4ldg2nw-morph

Pushing paths to cookiemonster (@cookiemonster):
    * /nix/store/zc05zrcs3kfms3mgysv6f2sxhk1pk3pc-nixos-system-cookiemonster-21.11pre-git

Executing 'switch' on matched hosts:

** cookiemonster
Please enter remote sudo password:
could not find any previously installed systemd-boot
stopping the following units: dns-hosts-poller.service
activating the configuration...
setting up /etc...
reloading user units for ckie...
setting up tmpfiles
starting the following units: dns-hosts-poller.service

Running healthchecks on cookiemonster (cookiemonster):
Health checks OK
Done: cookiemonster
ckie@cookiemonster ~/git/nixfiles -> host cookiemonster.tailnet.ckie.dev localhost
Using domain server:
Name: localhost
Address: ::1#53
Aliases:

cookiemonster.tailnet.ckie.dev has address 100.77.146.21
```

that's pretty cool! but i really don't want to type `cookiemonster.tailnet.ckie.dev` every single time, and there's a easy solution for that:
```
Manual page configuration.nix(5) line 8628 
       networking.search
           The list of search paths used when resolving domain names.

           Type: list of strings

           Default: [ ]

           Example: [ "example.com" "home.arpa" ]

           Declared by:
               <nixpkgs/nixos/modules/tasks/network-interfaces.nix>
```

```nix
      networking.search = singleton ".tailnet.ckie.dev";
      # /nixpkgs/lib/lists.nix has this:
      #   singleton = x: [x];
```

```
# this is a bit weird
ckie@cookiemonster ~/git/nixfiles -> host cookiemonster
host: '.tailnet.ckie.dev' is not in legal name syntax (empty label)
# but ping seems to work, so it's alright..
ckie@cookiemonster ~/git/nixfiles -> ping cookiemonster -c1
PING cookiemonster(localhost (::1)) 56 data bytes
64 bytes from localhost (::1): icmp_seq=1 ttl=64 time=0.035 ms

--- cookiemonster ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.035/0.035/0.035/0.000 ms
```
