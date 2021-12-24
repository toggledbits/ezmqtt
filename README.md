# ezmqtt

*ezmqtt* is a gateway between Ezlo hubs and MQTT brokers. It enables you to use your Ezlo hub with MQTT-compatible subsystems and applications like *Node-RED* and others. It monitors the hub for state changes and publishes them as MQTT topics.

This is a community supported project. If you find *ezmqtt* useful, please consider making a donation at [https://www.toggledbits.com/donate](https://www.toggledbits.com/donate) (PayPal, BTC), and thank you in advance for your support. I am not affiliated with Ezlo Innovation, just a long-time independent developer in the IoT space who likes to make cool tools.

## Installation

*ezmqtt* is available for local installation via *npm* (Node Package Manager) from *npmjs.com*, or as a *Docker* container using official images from the *toggledbits* repository at *hub.docker.com*. These are the only official sources for *ezmqtt*. Be wary of other sources, as these may contain malware and other unverified software.

### Via NPM

To install using *npm*, you will need to have *nodejs* version 16.13 (LTS) or higher installed. Then:

    npm i -g ezmqtt

The configuration file `ezmqtt-config.yaml` will then need to be edited. This file will be in the directory in which *ezmqtt* was installed, usually in the library path of your system. 

### Via DockerHub (Docker image)
	
Docker images for various architectures are available (officially) from the [*toggledbits* DockerHub repository](https://hub.docker.com/r/toggledbits/ezmqtt).

The image requires a bind mount at `/var/ezmqtt` to a directory of your choice outside the container. It is here that the *ezmqtt* configuration file will live, and any data dump and log files will be written.

It is possible, perhaps even recommended, to run *ezmqtt* under *docker-compose*. The following is a pro-forma compose file for that purpose:

```
# TBD - compose file
```

## Configuration

### Configuring the MQTT Broker Connection

The only configuration item needed for the MQTT broker connection is `mqtt`, the value of which is the URL to connect to your MQTT broker. If not set, the default `mqtt://127.0.0.1:1883` is used (*ezmqtt* attempts to find the broker on `localhost`).

### Configuring the Ezlo Hub Connection

By default, Ezlo hubs require an access token, obtained from their cloud services, to access the API on the hub (needed for *ezmqtt*). Once an access token is acquired, the hub can then be accessed via its local API (recommended), or using the cloud relay (the only option available for older Atom and PlugHub hubs, which don't have local API access).

* `serial` &mdash; serial number of the hub to be connected
* `username` and `password` &mdash; access credentials for the Ezlo cloud services. Set up a username and password in the Ezlo/Vera mobile application.
* `endpoint` &mdash; (optional) the IP address or websocket URL to which the data connection should be made. When this key is used (recommended), the value must be the local IP address of the hub, or a WebSocket URL in the form `wss://local-hub-ip-or-hostname:17000`. If this key is not used, *ezmqtt* will use the Ezlo cloud relay.

The use of the cloud relay for "production" home automation is not recommended, as it creates a heavy, ongoing dependency on Internet access and the Ezlo cloud services availability. When the `endpoint` is specified, the cloud services are only used to acquire an access token, which is long-lived (relatively speaking) and can survive brief outages. In the long run, however, you may want to consider setting up the hub for *offline anonymous access*, which allows *ezmqtt* to access the local API on the hub without an access token from the cloud (or any other authentication), removing the cloud dependency entirely. See the detailed discussion under *Ezlo Offline Anonymous Access* below for more information.

### Logging Configuration

Detailed logging can be turned on or off by setting the `debug` key in the configuration to `true` or `false`, respectively.

## Telemetry Topics Published

*ezmqtt*'s telemetry topics are published when the Ezlo hub announces a change to an item or device. The following telemetry topics are currently defined to report changes to *items* (device states in most cases, but have many purposes in Ezlo firmware). The payload for each is the new item value. Refer to the [Ezlo API Documentation](https://api.ezlo.com/devices/item_value_types/index.html) for details on item values and types.

* `ezmqtt/tele/device/<device-id>/item/<item-name>`
* `ezmqtt/tele/item/<item-id>`

The reason for two equivalent messages is simply to give the end-user choice. It's harder to wrangler with IDs, and item IDs can be problematic if the device is reinventoried/reconfigured and the items purged and recreated. It may seem inconsistent in the first topic to use item name with device ID rather than device name, but device names are not stable references to a device (you can change the name, wrecking your code/rules/conditions). Since device IDs are stable and far fewer in number than item IDs, this was deemed an acceptable, perhaps even desirable, trade-off.

When a device changes (i.e. its name, reachability, etc.), the `ezmqtt/tele/device` topic is published by *ezmqtt*. The payload is an object containing the full device data as reported by the hub, extended to include the current value of all items associated with the device (an object under the `items` key within the payload).

The `ezmqtt/tele/mode/changing` is sent when a house mode change is initiated. When the mode change completes or is cancelled, a `ezmqtt/tele/mode/current` topic is published with the then-current house mode ID and name (as on object, for example, `{ "id": 1, "name": "Home" }`.

The `ezmqtt/tele/hub/status` topic is published when the hub reports a change in its gateway status.

All of the above topics except `ezmqtt/tele/mode/changing` are sent with QoS 1 and message retention requested. In this way, subscribers will get immediate updates upon subscription to the broker.

## Commanding Devices

Ezlo hubs generally command devices by setting item values. For example, if you want a dimmer at 50%, you would use `hub.item.value.set` to set the `dimmer` item's value to 50. The following topics are defined for this purpose and can be published by your applications:

* `ezmqtt/set/device/<device-id>/item/<item-name>`
* `ezmqtt/set/item/<item-id>`

Notice that the former uses the item name, and the latter uses the unique device ID. See *Telemetry Topics* for a review of why this apparent inconsistency was chosen.

If these topics are given with a payload, *ezmqtt* will attempt to set the target item's value to the payload. Payload for simple (primitive) type, like numbers, booleans, and strings, are given directly as presented (e.g. the payload "50" would represent either the string "50" or the number 50). Because all MQTT payloads are strings, *ezmqtt* will attempt conversion of the payload to the type required by the item. Other types (arrays, objects) must be given in JSON form and are passed through directly with no conversion (so make sure the payload meets the requirements of the item).

If either of the above topics is sent with no payload, the current value of the item is published. This makes it possible to query an item.

A free-form topic allows you to run any *method* (Ezlo's term for a command to the hub):

    ezmqtt/cmd/<method-name>

The `method-name` may be given in Ezlo's standard form (e.g. `hub.device.setting.value.set` to the topic would be `ezmqtt/cmd/hub.device.setting.value.set`), or in MQTT topic form (e.g. for the same method, `ezmqtt/cmd/hub/device/setting/value/set`). The payload must be a JSON string containing the contents of the `params` object to be sent on the request (i.e. the payload *is* the `params` that will be passed). If the method has no payload, the payload can be omitted/empty or an empty object (e.g. `{}`).

## Nodes for *Node-RED*

I am writing and will be publishing a set of nodes for *Node-RED* &mdash; coming soon!

## Cautions

The Ezlo Innovations hubs run on new firmware that has been in development since 2018 and is not yet officially released. It's more like a perpetual beta. Currently, the login/authentication process for accessing the hub API is not documented (although the API itself is &mdash; why document the API if you don't document how to access it?). The process being used by this package and pretty much everything else was derived from direct conversations with their engineers. It involves all of the things you don't want to see in a production environment: hard-coded URLs, well-known/publicly-exposed password salts, the use of a known-compromised hash, etc. It all works, though. For now. It could change at any time. Official documentation of a real process has been requested, and to date, those requests have gone unanswered. One possible mitigation strategy for a sudden outage caused by any future unannounced changes in the login process would be to run your hub with requiring authentication for the local API. See *Ezlo Offline Anonymous Access* below for further discussion.

## Ezlo Offline Anonymous Access

Because the default configuration of an Ezlo hub requires that an authorization token be acquired from their cloud services to connect to the hub's API, it's possible that *ezmqtt* could find itself in a situation (like an Ezlo cloud service outage, or local Internet outage) in which the hub is up and running locally, but *ezmqtt* can't access it because it can't reach the cloud services to get a token. The result would be an inability of *ezmqtt* to follow the changes occurring to hub device and items, and this would downstream affect any applications or services relying on its published topics in response.

Ezlo's security intent here is a Good Thing, but it always comes with a trade-off. Only you can judge if the risk created by power failures, Internet outages, and lapses in uptime of Ezlo's cloud services is acceptable when weighed against the need of your home automation/application for accuracy and uptime. If you can't bear that risk, there is an option: *offline anonymous access*.

Enabling offline anonymous access on the hub allows an application (like *ezmqtt*) to access the hub without an authorization token, or any authentication of any kind. This eliminates the dependencies on both Internet access and Ezlo's cloud services, but comes with the trade-off that the security of the hub is degraded by the local API connection being fully open. It would be required of you, then, to take other approaches to securing the hub from unauthorized access. There are no free lunches, particularly in network security. 

**Note that since local API access is not a feature of early Atom and PlugHub models, authenticated or otherwise, this feature is not available to them and this section does not apply.** These early models are highly cloud dependent, and in my opinion, a waste of money for any serious home automation.

If you wish to enable and use offline anonymous access, you can enable it yourself, if you know how, or you can let *ezmqtt* set it for you. It requires that secure, authenticated access be working to make the change. You must follow these instructions *exactly*. Make sure you follow each step, and do not skip any.

1. Make sure your `ezlo_hub` configuration includes `serial`, `username` and `password`, and that *ezmqtt* can successfully access the hub with the given credentials. If not, you cannot complete this process &mdash; fix your account/cloud access first. Authenticated access is required to enable anonymous access.
1. In the `ezlo_hub` section of the configuration file, add `set_anonymous_access: true` and restart *ezmqtt*. It will get a cloud token, access the hub (either locally or via the cloud relay, depending on your `endpoint` configuration setting), and then enable anonymous access. The hub will then reboot.
2. When the hub finishes rebooting and the *ezmqtt* log shows that it has reconnected, stop *ezmqtt*.
3. Comment out (or remove) the `username` and `password` lines from the configuration file.
4. Make sure the `endpoint` configuration line is uncommented and its value is the local IP address (or WebSocket URL) for the hub.
5. Start *ezmqtt* again and watch it connect to the hub.

When *ezmqtt* connects using an unauthenticated API connection, it will report that fact in its logs:

```
mqtt: connecting to Ezlo hub
ezlo: hub connection to 12345678 at wss://192.168.1.23:17000
mqtt: subscribed to ezmqtt/#
ezlo: hub websocket connected (wss://192.168.1.23:17000)
ezlo: unauthenticated hub websocket connected
ezlo: requesting hub info
...
```

If you later decide you want to turn anonymous access off anf go back to authenticated access, just add `set_anonymous_access: false` to your configuration (in the `ezlo_hub` section), restore/uncomment the `username` and `password` fields, and make sure they have valid values. Then restart *ezmqtt*. When the hub reboots, the setting is changed and you can then remove `set_anonymous access: false` from the configuration.

**Note:** Firmware updates of the hub may reset this setting, so from time to time, you may need to reset it. That's also troublesome for uptime, so disabling automatic updates of the hub is *highly* recommended.

---

## Copyright and License

*ezmqtt* is Copyright (C) 2021, Patrick H. Rigney, All Rights Reserved.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License version 3 as published by the Free Software Foundation.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

Please see the License.md file for a copy of the license. You should have received this file/copy of the GNU General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
