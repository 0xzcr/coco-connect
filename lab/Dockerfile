# One "laptop" in the network lab (test/lab.test.ts): Node 20, the oldest Node the plugin supports,
# plus git and the tools the lab uses to break the network on purpose (iptables, tc).
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git iptables iproute2 \
 && rm -rf /var/lib/apt/lists/*

# The test repos are mounted from the Mac and owned by a different user id.
RUN git config --system safe.directory '*'
