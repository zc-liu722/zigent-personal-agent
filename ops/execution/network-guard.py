#!/usr/bin/env python3
"""Reapply the task network boundary after every guest/container-engine restart."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import subprocess

# IANA IPv4 Special-Purpose Address Registry, checked 2026-10-29:
# https://www.iana.org/assignments/iana-ipv4-special-registry/
# Multicast is not public unicast egress. Do not blanket-deny all IANA entries:
# AS112/AMT ranges and the two protocol-anycast exceptions are globally reachable.
NON_PUBLIC_IPV4 = (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.88.99.2/32', '192.168.0.0/16', '198.18.0.0/15',
    '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
)
GLOBAL_EXCEPTIONS = ('192.0.0.9/32', '192.0.0.10/32')


def denied_destinations():
    for value in NON_PUBLIC_IPV4:
        networks = [ipaddress.IPv4Network(value)]
        for exception in map(ipaddress.IPv4Network, GLOBAL_EXCEPTIONS):
            networks = [part for network in networks
                        for part in (network.address_exclude(exception) if exception.subnet_of(network) else [network])]
        yield from map(str, networks)


def run(*arguments):
    return subprocess.run(arguments, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout


def remove_rule(chain, arguments):
    while True:
        exists = subprocess.run(['/usr/sbin/iptables', '-w', '10', '-C', chain, *arguments], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if exists.returncode == 1:
            return
        exists.check_returncode()
        run('/usr/sbin/iptables', '-w', '10', '-D', chain, *arguments)


def rule(chain, arguments):
    # Keep these precise managed rejects ahead of unrelated ACCEPT/RETURN rules.
    remove_rule(chain, arguments)
    run('/usr/sbin/iptables', '-w', '10', '-I', chain, '1', *arguments)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if os.getuid() != 0:
        raise RuntimeError('Network guard requires host maintenance privileges')
    config = json.loads(Path(args.config).read_text())
    if config.get('network', 'none') == 'none':
        return
    if config['network'] != 'zigent-execution':
        raise RuntimeError('Unrecognized task network')
    network = json.loads(run('/usr/bin/docker', 'network', 'inspect', 'zigent-execution'))[0]
    if network.get('EnableIPv6') or network.get('Options', {}).get('com.docker.network.bridge.enable_icc') != 'false':
        raise RuntimeError('Task network boundary configuration changed')
    subnet = network['IPAM']['Config'][0]['Subnet']
    bridge = network.get('Options', {}).get('com.docker.network.bridge.name') or 'br-' + network['Id'][:12]
    # Fail closed while updating a live broker's rules. An unsuccessful apply
    # deliberately retains this exact quarantine; a later successful apply
    # removes it only after every required boundary is in place. No task is killed.
    quarantine = ['-s', subnet, '-m', 'comment', '--comment', 'zigent-guard-updating', '-j', 'REJECT']
    host_quarantine = ['-i', bridge, '-m', 'comment', '--comment', 'zigent-guard-updating', '-j', 'REJECT']
    run('/usr/sbin/iptables', '-w', '10', '-I', 'DOCKER-USER', '1', *quarantine)
    run('/usr/sbin/iptables', '-w', '10', '-I', 'INPUT', '1', *host_quarantine)
    for destination in denied_destinations():
        rule('DOCKER-USER', ['-s', subnet, '-d', destination, '-m', 'comment', '--comment', 'zigent-public-egress', '-j', 'REJECT'])
    rule('INPUT', ['-i', bridge, '-m', 'comment', '--comment', 'zigent-host-boundary', '-j', 'REJECT'])
    remove_rule('DOCKER-USER', quarantine)
    remove_rule('INPUT', host_quarantine)


if __name__ == '__main__':
    main()
