
/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import subHTML from '../public/subscribe.html';
import chatHTML from '../public/chat.html';

const TWITCH_MESSAGE_ID = 'Twitch-Eventsub-Message-Id'.toLowerCase();
const TWITCH_MESSAGE_TIMESTAMP = 'Twitch-Eventsub-Message-Timestamp'.toLowerCase();
const TWITCH_MESSAGE_SIGNATURE = 'Twitch-Eventsub-Message-Signature'.toLowerCase();
const TWITCH_MESSAGE_TYPE = 'Twitch-Eventsub-Message-Type'.toLowerCase();
const TWITCH_SUB_TYPE = 'Twitch-Eventsub-Subscription-Type'.toLowerCase();

const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';
const HMAC_PREFIX = 'sha256=';

const subURL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const chatURL = 'https://api.twitch.tv/helix/chat/messages';

const crypto = require('crypto');
const subTypes = 'channel.chat.message;channel.chat.notification;channel.shared_chat.begin;channel.shared_chat.update;channel.shared_chat.end;'

export default {
	async fetch(request, env, ctx) {

		let devlogging = true; // toggle false or true to enable/disable log statements.
		
		function devLog(msg, error){
			if(!devlogging) return;
			if(error){
				console.error(msg);
			} else {
				console.log(msg)
			}
		}

		class Database {

			static async get(key) {
				try {
					return await fetch(env.FIREBASE_URL + encodeURIComponent(key) + "/.json?auth=" + env.FIREBASE_SECRET)
						.then(e => e.text())
						.then(value => {
							if (!value) return null;
							try { value = JSON.parse(value); }
							catch { return null; }
							if (value === undefined || value === null || value.error !== undefined) return null;
							return value;
						});
				} catch (e) {
					console.log(e);
					console.error("Failed to get " + key);
				}
			}

			static async set(key, value) {
				try {
					await fetch(env.FIREBASE_URL + encodeURIComponent(key) + "/.json?auth=" + env.FIREBASE_SECRET, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(value),
					});
				} catch (e) {
					console.log(e);
					console.error("Failed to set " + key);
				}

			}

			static async delete(key) {
				await fetch(
					env.FIREBASE_URL + encodeURIComponent(key) + "/.json?auth=" + env.FIREBASE_SECRET,
					{ method: "DELETE" }
				);
			}

			static async dictionary() {
				return await fetch(`${env.FIREBASE_URL}/.json?auth=${env.FIREBASE_SECRET}`)
					.then(e => e.text())
					.then(value => {
						if (!value) return null;
						try { value = JSON.parse(value); }
						catch { return null; }
						if (value === undefined || value === null || value.error !== undefined) return null;
						return value;
					});
			}

		}

		let TWITCH_APP_ID = await Database.get("twitch_app_id");
		let TWITCH_APP_SECRET = await Database.get("twitch_app_secret");
		let TWITCH_REFRESH = await Database.get("twitch_refresh_token");
		let TWITCH_OAUTH_BOT = await Database.get("twitch_oauth_bot");
		let TWITCH_APP_TOKEN = await Database.get("twitch_app_token");

		class Queue {
			#queue = null;
			enabled = false;
			async lock() {
				try {
					let Q_lock = await Database.get("Q_lock");
					if (!Q_lock) await Database.set("Q_lock", true);
				} catch (e) {
					console.log(e);
					console.error("Failed to lock");
				}

			}
			async C_lock() {
				try {
					let QC_lock = await Database.get("QC_lock");
					if (!QC_lock) await Database.set("QC_lock", true);
				} catch (e) {
					console.log(e);
					console.error("Failed to c_lock");
				}

			}
			async unlock() {
				try {
					let Q_lock = await Database.get("Q_lock");
					if (Q_lock) await Database.set("Q_lock", false);
				} catch (e) {
					console.log(e);
					console.error("Failed to unlock");
				}
			}
			async C_unlock() {
				try {
					let QC_lock = await Database.get("QC_lock");
					if (QC_lock) await Database.set("QC_lock", false);
				} catch (e) {
					console.log(e);
					console.error("Failed to c_unlock");
				}
			}

			async knock() {
				try {
					let Q_prom = Database.get("Q_lock");
					let Q_lock = await Q_prom;

					let retry = 0;
					for (let i = 0; i <= 3; i++) {
						try {
							if (Q_lock == false) {
								await this.lock();
								return
							} else {
								retry = i + 1;
								setTimeout(() => console.log("locked, retry number " + retry), 50);
							}
						} catch (e) {
							console.log(e);
							console.error("Failed in Knock for loop");
							throw e
						}
					}
				} catch (e) {
					console.log(e);
					console.error("Failed to knock");
				}

			}

			async C_knock() {
				let QC_lock = Database.get("QC_lock"); // Make the same as knock (after we've fixed it) #TODO
				let retry = 0;
				while (retry <= 3) {
					try {
						if (QC_lock) {
							await this.C_lock();
							return
						} else {
							retry++;
							setTimeout(() => console.log("locked, retry number " + retry), 50);
						}
					} catch (e) {
						throw e
					}
				}
			}

			async #prepare() {
				if (this.#queue !== null) return;
				await this.knock();
				this.#queue = (await Database.get("queue")) || [];
				await this.unlock();
			}

			async #update() {
				await this.#prepare();
				await this.knock();
				await Database.set("queue", this.#queue);
				await this.unlock();
			}

			async enqueue(user, profile, sub = false) {
				await this.#prepare();
				await this.C_knock();
				if (this.#queue.findIndex(e => e.user === user) !== -1) {
					await this.C_unlock()
					return undefined;
				}
				if (this.#queue.findIndex(e => e.profile === profile) !== -1) {
					await this.C_unlock()
					return null;
				}
				let position;
				if (!sub) {
					this.#queue.push({ user, profile, sub });
					position = this.#queue.length;
				} else {
					let i = 0;
					while (i < this.#queue.length && this.#queue[i].sub) i++;
					this.#queue.splice(i, 0, { user, profile, sub });
					position = i + 1;
				}
				await this.#update();
				await this.C_unlock();
				return position
			}

			async dequeue() {
				await this.#prepare();
				await this.C_knock();
				if (this.#queue.length === 0) {
					await this.C_unlock();
					return undefined;
				}
				const removed = this.#queue.shift();
				await this.#update();
				await this.C_unlock();
				return removed;
			}
			async position(user) {
				await this.#prepare();
				const index = this.#queue.findIndex(e => e.user == user);
				if (index === -1) return [null, null];
				return [this.#queue[index], index + 1];
			}

			async remove(data) {
				await this.#prepare();
				await this.C_knock();
				const index = this.#queue.findIndex(
					e => e.user === data || e.profile === data
				);
				if (index === -1) {
					await this.unlock();
					return false;
				}
				const removed = this.#queue[index];
				this.#queue.splice(index, 1);
				await this.#update();
				await this.C_unlock();
				return [removed.user, removed.profile];
			}
			async clear() {
				await this.#prepare();
				await this.C_knock();
				this.#queue = [];
				await this.#update();
				await this.C_unlock();
			}

			async list() {
				await this.#prepare();
				return this.#queue || [];
			}

			async size() {
				await this.#prepare();
				return this.#queue.length;
			}
		}

		class TwitchChat {
			#secret;
			#actions = [];
			#programmables = [];
			#announcements = [];
			challenge = false;
			queue = new Queue();

			Streamer = "thechessnerdlive";
			hearts = { '🧡': "orange", '💚': "green", '💙': "blue", '💜': "purple" };

			#QUERIES = {
				search: { channel: "search/channels?query=" },
				streams: "streams?user_id=",
				schedule: "schedule?broadcaster_id="
			};

			#HEADERS = {
				headers: {
					"Authorization": "Bearer " + TWITCH_OAUTH_BOT,
					"Client-Id": TWITCH_APP_ID
				}
			};

			constructor() {
				this.#getSecret();

			}

			async init() {
				let res;
				let count = await this.getSubscriptions().total;
				res = await this.subscribe(subTypes);
				this.#actions = await this.reloadActions();
				return res

				// if (count == 0) {
				// 	console.log("here");
				// 	res = await this.subscribe(subTypes);
				// 	console.log(res);
				// 	return res
				// }
				// return "Sub already exists"
			}

			async reloadActions() {
				this.initProgrammables();
				const A = await Database.get('actions');
				if (A === undefined || A === null) return [];
				return A;
			}
			async reloadAnnouncements() {
				const A = await Database.get('announcements');
				if (A === undefined || A === null) return [];
				return A;
			}

			async refresh() {
				this.#actions = await reloadActions();
				this.#announcements = await reloadAnnouncements();
			}

			allowed(badges, permissions) {
				let tags = {
					sub: false,
					vip: false
				};
				const badgesArray = Object.values(badges);
				for (const badge of badgesArray) {
					if (badge.set_id == 'moderator' || badge.set_id == 'broadcaster') return true;
					if (badge.set_id == 'subscriber') tags.sub = true;
					if (badge.set_id == 'vip') tags.vip = true;
				}

				switch (permissions) {
					case 'mod':
						return false;
					case 'sub':
						return tags.sub;
					case 'vip':
						return tags.vip;
					case 'all':
					default: return true;
				}
			}

			async handler(message) {
				devLog("Inside Handler with " + message);
				if (message === undefined) return;
				// for (const heart in this.hearts) if (message.startsWith(heart)) {
				// 	this.#commands.announce(message.substring(1).trim(), hearts[heart]); // create an announce function to announce the message #TODO
				// 	return;
				// }
				await this.chat(message);
			};

			async notification(request) {
				devLog("notification recieved.");
				let message = this.#getHmacMessage(request);
				if (message == 0) {
					console.error("non hmac message");
					return 0
				}
				let messageType = request.headers.get(TWITCH_MESSAGE_TYPE);
				let hmac = HMAC_PREFIX + this.#getHmac(this.#secret, message);

				if (this.#verifyMessage(hmac, request.headers.get(TWITCH_MESSAGE_SIGNATURE))) {
					const data = await request.json();
					switch (messageType) {
						case MESSAGE_TYPE_NOTIFICATION:
							let notiType = request.headers.get(TWITCH_SUB_TYPE);
							switch (notiType) {
								case "channel.chat.message":
									let messageText = data.event.message.text;
									let badges = data.event.badges;
									devLog(messageText);
									if (!messageText.startsWith('!')) return;

									const RRSLV = new RegExp(`![A-Za-z0-9_\\.]+`, 'i');
									let command = RRSLV.exec(messageText);
									if (/\b(command|use|type)\b/i.test(messageText)) return;
									command = command[0].trim().replace('!', '').toLowerCase();

									this.#actions = await this.reloadActions();

									for (const action of this.#actions) {
										if (!action.commands.includes(command)) continue;
										if (!this.allowed(badges, action.permissions)) return;
										if (action.reply !== undefined) await this.handler(action.reply);
										return;
									}
									for (const action of this.#programmables) {
										if (!action.commands.includes(command)) {
											continue;
										}
										if (!this.allowed(badges, action.permissions)) {
											return;
										}
										if (action.execute.constructor.name === 'AsyncFunction') {
											await action.execute(data).then((m) => this.handler(m));
											return;
										} else {
											await this.handler(action.execute(data));
											return;
										}
									}
								case "channel.chat.notification":
								case "channel.shared_chat.begin":
								case "channel.shared_chat.update":
								case "channel.shared_chat.end":
							}
							return 204
						case MESSAGE_TYPE_VERIFICATION:
							return data.challenge
						case MESSAGE_TYPE_REVOCATION:
							return 204
						default:
							return 403
					}

				}
				console.error("message was unable to be verified");
				return 0
			}

			async getSubscriptions() {

				let url = 'https://api.twitch.tv/helix/eventsub/subscriptions';
				let payload = {
					method: "GET",
					headers: {
						"Authorization": "Bearer " + TWITCH_APP_TOKEN,
						"Client-Id": TWITCH_APP_ID
					}
				}

				let response = await fetch(url, payload);

				let data = await response.json();
				return data
			}

			async subscribe(subscriptions) {
				let items = subscriptions.split(";");
				let responses = {};

				for (const item of items) {
					let payload = {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Authorization": "Bearer " + TWITCH_APP_TOKEN, // and this
							"Client-Id": TWITCH_APP_ID // need to pull this from database
						},
						body: JSON.stringify({
							type: item,
							version: "1",
							"condition": {
								"broadcaster_user_id": "428214501",
								"user_id": "993360877"
							},
							transport: {
								method: "webhook",
								callback: "https://cloudflare-en-passant.chanceloricco-chessnerd.workers.dev/callback",
								secret: this.#secret
							}
						})
					};

					let response = await fetch(subURL, payload);

					if (response.status == 202) {
						let resJson = await response.json();
						let { data } = await resJson;
						let [subData] = await data;
						subData.status = 202;
						responses.item = subData;
					} else {
						let temp = await response.json();
						responses.item = temp;
					}
				}
				return responses
			}

			async delete(id) {
				let payload = {
					method: "DELETE",
					headers: {
						"Content-Type": "application/json",
						"Authorization": "Bearer " + TWITCH_APP_TOKEN, // and this
						"Client-Id": TWITCH_APP_ID // need to pull this from database
					}
				}
				let url = 'https://api.twitch.tv/helix/eventsub/subscriptions?id=' + id;
				let response = await fetch(url, payload)
				switch (response.status) {
					case 204:
						console.log("Successfully Deleted");
						return "Successfully Deleted"
					case 400:
						console.log("ID required");
						return "ID required"
					case 401:
						console.log("Unauthorized - Bad header, Token, or ID doesn't match token");
						return "Unauthorized - Bad header, Token, or ID doesn't match token"
					case 404:
						console.log("Sub not found");
						return "Sub not found"
				}
			}

			async deleteAll() {
				let ids = await this.getSubscriptions()

				for (const item of ids.data) {
					await this.delete(item.id);
				}
			}

			async validate() {
				try {
					devLog("Validating OAUTH");
					// Validate OAUTH Token
					TWITCH_OAUTH_BOT = await Database.get("twitch_oauth_bot");
					TWITCH_APP_TOKEN = await Database.get("twitch_app_token");
					let url = "https://id.twitch.tv/oauth2/validate";

					const req = await fetch(url, {
						headers: {
							"Authorization": "OAuth " + TWITCH_OAUTH_BOT
						}
					});
					devLog(await req.text());

					const reqApp = await fetch(url, {
						headers: {
							"Authorization": "OAuth " + TWITCH_APP_TOKEN
						}
					});
					devLog(await reqApp.text());
					if(req.status != 401 && reqApp.status != 401){
						devLog("validate success on both");
						return 200
					} else {
						devLog("validate unsuccessful, refreshing");
						await this.appToken();
						await this.twitchRefresh();
					}
					
				} catch (e) {
					console.log(e);
					console.error("Token Validation failed!");
				}
			}

			async twitchRefresh() {
				devLog("twitch refresh");
				try {
					TWITCH_APP_ID = await Database.get("twitch_app_id");
					TWITCH_APP_SECRET = await Database.get("twitch_app_secret");
					TWITCH_REFRESH = await Database.get("twitch_refresh_token");
					const details = {
						"client_id": TWITCH_APP_ID,
						"client_secret": TWITCH_APP_SECRET,
						"grant_type": "refresh_token",
						"refresh_token": TWITCH_REFRESH
					};
					let formBody = [];
					for (let property in details) {
						let encodedKey = encodeURIComponent(property);
						let encodedValue = encodeURIComponent(details[property]);
						formBody.push(encodedKey + '=' + encodedValue);
					}
					formBody = formBody.join('&');
					const response = await fetch("https://id.twitch.tv/oauth2/token", {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
						},
						body: formBody
					});
					devLog(response.status);
					if (response.status != 200) {
						console.error("Failed to refresh twitch token");
						return;
					}
					const data = await response.json();
					devLog("twitchRefresh response..");
					devLog(data);
					if (!("scope" in data) || !("access_token" in data) || !("refresh_token" in data)) {
						console.error("Refresh twitch token not present");
						return;
					}
					await Database.set("twitch_oauth_bot", data.access_token);
					TWITCH_OAUTH_BOT = data.access_token;
					await Database.set("twitch_refresh_token", data.refresh_token);
					TWITCH_REFRESH = data.refresh_token;
					return data.access_token;
				} catch (e) {
					console.log(e);
					console.error("Twitch Refresh has failed!");
				}
			}

			async appToken() { // No way to refresh client credential tokens - validate and refresh on expiry?
				devLog("app token refreshing..");
				try {
					const details = {
						"client_id": TWITCH_APP_ID,
						"client_secret": TWITCH_APP_SECRET,
						"grant_type": "client_credentials"
					};
					let formBody = [];
					for (let property in details) {
						let encodedKey = encodeURIComponent(property);
						let encodedValue = encodeURIComponent(details[property]);
						formBody.push(encodedKey + '=' + encodedValue);
					}
					formBody = formBody.join('&');
					let payload = {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
						},
						body: formBody
					}
					let url = "https://id.twitch.tv/oauth2/token";
					let response = await fetch(url, payload);
					let json = await response.json();
					devLog("app response");
					devLog(json);
					await Database.set("twitch_app_token", json.access_token);
					TWITCH_APP_TOKEN = json.access_token;
				} catch (e) {
					console.log(e);
					console.error("Failed to retrieve App Token");
				}
			}

			async chat(message) {
				devLog("this.chat..");
				let payload = {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Authorization": "Bearer " + TWITCH_APP_TOKEN, // TWITCH_APP_TOKEN (but its invalid?? idk why)
						"Client-Id": TWITCH_APP_ID
					},
					body: JSON.stringify({
						"broadcaster_id": "428214501",
						"sender_id": "993360877",
						"message": message,
						"for_source_only": "true"
					})
				};
				let url = "https://api.twitch.tv/helix/chat/messages";
				let response = await fetch(url, payload);
				let body = await response.text();
				devLog(body);
			}

			#getSecret() {
				//generate secret or pull from somewhere - could use rand
				this.#secret = 'SECRET12310101';
			}

			#getHmacMessage(request) {
				if (request.headers.has([TWITCH_MESSAGE_ID])) {
					return (request.headers[TWITCH_MESSAGE_ID] +
						request.headers[TWITCH_MESSAGE_TIMESTAMP] +
						request.body);
				}
				return 0
			}

			#getHmac(secret, message) {
				return crypto.createHmac('sha256', secret)
					.update(message)
					.digest('hex');
			}

			#verifyMessage(hmac, verifySignature) {
				return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(verifySignature, 'hex'));
			}

			async channel(streamer) {
				if (streamer === "") return undefined;
				try {
					const queryUrl = buildUrl(this.#QUERIES.search.channel);
					const req = await fetch(queryUrl + streamer + "&first=1", this.#HEADERS);
					if (req.status != 200) return null;
					const data = (await req.json()).data;
					for (const channel of data)
						if (channel.display_name.toLowerCase() === streamer.toLowerCase())
							return channel;
				} catch { return undefined; }
				return undefined;
			}

			async live(streamer) {
				const c = await channel(streamer);
				if (c == undefined || c == null) return c;
				return c.is_live;
			}

			async schedule(id, date) {
				date = date || new Date().toISOString();
				const url = `${BASE_URL}schedule?broadcaster_id=${id}&start_time=${date}&first=7`;
				try {
					const req = await fetch(url, HEADERS);
					if (req.status != 200) return null;
					const data = (await req.json()).data;
					return data;
				} catch { return null; }
			}

			async uptime(streamer) {
				const c = await channel(streamer);
				if (c === undefined || c === null || !c.is_live ||
					c.started_at === undefined || c.started_at === "") return null;
				const s = new Date(c.started_at);
				const e = new Date();
				const d = e.getTime() - s.getTime();
				const h = Math.floor((d % Time.day) / Time.hour);
				const m = Math.floor((d % Time.hour) / Time.minute);
				return h > 0 ? `${h}h ${m}m` : `${m}m`;
			}

			async follow_count(streamer) {
				const url = `https://twitchtracker.com/api/channels/summary/${streamer}`;
				try {
					const req = await fetch(url);
					if (req.status != 200) return null;
					const data = await req.json();
					return "followers_total" in data ? data.followers_total : null;
				} catch { return null; }
			}

			programmable(command) {
				if (typeof command.execute !== 'function') return;
				if (command.commands === undefined) return;
				if (typeof command.commands === 'string')
					command.commands = command.commands.split(/\s+/g);
				if (command.permissions === undefined) command.permissions = 'all';
				this.#programmables.push(command);
			}

			ordinal = n => {
				const s = ["th", "st", "nd", "rd"];
				const v = `${n}`, l = parseInt(v[v.length - 1]);
				if (n == 11 || n == 12 || n == 13) return `${n}th`;
				return n + (l < 4 ? s[l] : s[0]);
			};

			initProgrammables() {
				// ==== Challenge ==============================================================

				this.programmable({
					commands: ["challenge"],
					description: "Challenge Zach to a game.",
					execute: () => this.challenge ?
						"Zach is accepting challenges today, !join the queue to play him." :
						"Sorry, Zach is not accepting challenges today."
				});

				this.programmable({
					commands: ["togglec"], permissions: "mod",
					description: "Toggle the challenge message.",
					execute: () => {
						this.challenge = !this.challenge;
						return `Challenge mode is currently ${this.challenge ? "on" : "off"}.`;
					}
				});

				// ==== Generic Info ===========================================================

				this.programmable({
					commands: ["time", "timezone"],
					description: "Gets Zach's current time.",
					execute: () => `For Zach it is ${(new Date()).toLocaleTimeString("en-US", {
						timeZone: "Europe/Amsterdam", //timeZone: "America/Montreal",
						hour12: true, second: "2-digit", minute: "2-digit", hour: "numeric"
					}).replace(/:\d\d ([AP]M)/g, "$1").toLocaleLowerCase()}.`
				});

				this.programmable({
					commands: ["age", "birthday", "bday"],
					description: "Gets Zach's birthday.",
					execute: () => {
						const d = Date.now() - new Date("30 July 2001");
						const m = new Date(d);
						const a = Math.abs(m.getUTCFullYear() - 1970);
						return `Zach was born on the 30th of July 2001, he is currently ${a}.`;
					}
				});

				this.programmable({
					commands: ["uptime"],
					description: "Gets the uptime of the stream.",
					execute: async () => {
						const up = await uptime(this.Streamer);
						if (up === null) return "Zach is not currently streaming.";
						return `Zach has been streaming for ${await uptime(this.Streamer)}.`
					}
				});

				this.programmable({
					commands: ["followers"],
					description: "Gets the current number of followers.",
					execute: async () => `Zach has ${await follow_count(this.Streamer)} followers.`
				});

				this.programmable({
					commands: ["tos"], permissions: "vip",
					description: "Chess.com terms of service.",
					execute: data => {
						let user = data.message.match(/@(\w+)/);
						if (user === null || user.length < 2)
							return `Please don't suggest moves for the current position ` +
								`as it's against chess.com terms of service!`;
						user = user[1];
						return `@${user} please don't suggest moves for the current position ` +
							`as it's against chess.com terms of service!`;
					}
				});

				// https://api.2g.be/twitch/followage/thechessnerdlive/user?format=ymwd)
				this.programmable({
					commands: ["followage"], permissions: "all",
					description: "Gets your current follow age.",
					execute: async data => {
						const user = data.username;
						if (data.username === this.Streamer) {
							const d = Time.difference(new Date(), new Date(2022, 2, 19));
							let s = "Zach has been streaming for ";
							if (d.years > 0) s += `${d.years} years, `;
							if (d.months > 0) s += `${d.months} months, `;
							if (d.weeks > 0) s += `${d.weeks} weeks, `;
							if (d.days > 0) s += `${d.days} days.`;
							return s;
						}
						const response = await fetch(
							`https://api.2g.be/twitch/followage/${this.Streamer}/${user}?format=ymwd`
						);
						if (response.status !== 200) return;
						return '@' + (await response.text()).replace(this.Streamer + ' ', "");
					}
				});



				// ======= Queue.js ======== //

				this.programmable({
					commands: ['join'],
					description: 'Join the current queue.',
					// execute needs to be a function to access `this`.
					execute: async function (data) {
						if (!this.queue.enabled) return `The queue is closed.`;
						if (this.permissions === 'sub' && !data.tags.sub) // data is deprecated, fix #TODO
							return `@${data.username}, the queue is currently sub-only.`;
						const username = data.message.match(/join\s+([^ ]+)\s*/i);
						if (username === null || username.length < 2)
							return `@${data.username}, try with !join username`;
						if (username[1].toLowerCase().trim() === 'username')
							return `@${data.username}, really dude? r u 4 real?`;
						if (!(await Chess.com.exists(username[1])))
							return `@${data.username}, there is no Chess.com user "${username[1]}".`;
						const i = await this.queue.enqueue(data.username, username[1], data.tags.sub || data.tags.mod || data.tags.vip);
						if (i === undefined) return `@${data.username}, you're already in queue.`;
						if (i === null) return `@${username[1]} is already in queue.`;
						const p = "you're " + this.ordinal(i);
						if (data.username === username[1]) return `"${data.username}" ${p}.`;
						return `@${data.username} aka "${username[1]}" ${p}.`;
					}
				});

				this.programmable({
					commands: ['leave'],
					description: 'Leave the current queue.',
					execute: async data => {
						if (await queue.remove(data.username))
							return `@${data.username}, you left the queue.`;
						else return `@${data.username}, you're not in queue.`;
					}
				});

				this.programmable({
					commands: ['position', 'pos'],
					description: 'Get your position in the queue.',
					execute: async data => {
						const [_u, i] = await queue.position(data.username);
						if (i === null) return `@${data.username}, you're not in queue.`;
						return `@${data.username} you're ${this.ordinal(i)} / ${await queue.size()}.`;
					}
				});

				this.programmable({
					commands: ['insert'], permissions: 'mod',
					description: 'Insert somebody in the current queue.',
					execute: async data => {
						const username = data.message.match(/insert\s+@?(\w+)\s+(\w+)/i);
						if (username === null || username.length < 3)
							return `@${data.username}, try with ${P}insert "twitch" "Chess.com".`;
						if (!(await Chess.com.exists(username[2])))
							return `@${data.username}, there is no Chess.com user "${username[2]}".`;
						const i = await queue.enqueue(username[1], username[2]);
						if (i === undefined || i === null)
							return `@${data.username}, "${username[2]}" is already in queue.`;
						const j = this.ordinal(i);
						return `@${username[1]} aka "${username[2]}" is ${j}.`;
					}
				});

				this.programmable({
					commands: ['remove'], permissions: 'mod',
					description: 'Remove a user from the queue.',
					execute: async data => {
						let username = data.message.match(/remove\s+@?(\w+)/i);
						if (username === null || username.length < 2) return;
						username = username[1].replace(/"|'|@/g, '');
						const result = await queue.remove(username);
						if (result === false) return `${username} is not in queue.`;
						const [user, profile] = result;
						if (user === null) return `"${username}" is not in queue.`;
						return `@${user} aka "${profile}" has been removed.`;
					}
				});

				this.programmable({
					commands: ['next'], permissions: 'mod',
					description: 'Get the next in line in the queue.',
					execute: async () => {
						const element = await this.queue.dequeue();
						if (element === undefined) return `The queue is empty.`;
						if (element.user === element.profile) return `"${element.profile}" on Chess.com is next.`;
						return `@${element.user} aka "${element.profile}" on Chess.com is next.`;
					}
				});

				this.programmable({
					commands: ['queue', 'q'], permissions: 'mod',
					description: 'Displays the current queue.',
					execute: async () => {
						const list = await this.queue.list();
						if (list.length === 0) return 'The queue is empty.';
						return 'Queue: ' + list.map(e => e.profile).join(' -> ');
					}
				});

				this.programmable({
					commands: ['clear'], permissions: 'mod',
					description: 'Clears the current queue.',
					execute: async () => {
						await queue.clear();
						return 'The queue has been cleared.';
					}
				});

				this.programmable({
					commands: ['subq'], permissions: 'mod',
					description: 'Toggles subonly mode for the current queue.',
					execute: () => {
						const join = programmables.find(p => p.commands.includes('join')); // #TODO - maybe needs to be /this.programmables/?
						join.permissions = join.permissions == 'sub' ? 'all' : 'sub';
						return `Sub-only mode is now ${join.permissions == 'sub' ? 'on' : 'off'}.`;
					}
				});

				this.programmable({
					commands: ['toggleq'], permissions: 'mod',
					description: 'Toggles the queue on and off.',
					execute: () => {
						this.queue.enabled = !this.queue.enabled;
						return `The queue is now ${this.queue.enabled ? 'open' : 'closed'}.`;
					}
				});

				// ====== Ratings.js ====== //

				const ZACH_FIDE_ID = "2624346"; // #TODO - Move constants to the top so everything is declared properly
				const saxon_genitive = s => s + (s[s.length - 1] == 's' ? "'" : "'s");
				const emojis = {
					blitz: "⚡️", bullet: "🔫", rapid: "⏱️", classical: "⏳", standard: "🕰",
					daily: "☀️", tactics: "🧩", "puzzle rush": "🔥",
				};

				const CHESS_COM_REGEX = new RegExp("!(?:chess\\.?com|ratings)\\s+<?([A-Za-z0-9_\\-]+)>?");
				const PUZZLES_REGEX = new RegExp("!puzzles\\s+<?(\\w+)>?");
				const LICHESS_REGEX = new RegExp("!lichess(?:\\.org)?\\s+<?([A-Za-z0-9_\\-]+)>?");

				// this.programmable({
				// 	commands: ["fide"], permissions: "all",
				// 	description: "Gets Zach's FIDE official ratings.",
				// 	execute: async () => {
				// 		const player = await FIDE(ZACH_FIDE_ID); #TODO - need to either import FIDE stuff or build it myself!
				// 		if (player === undefined || player === null)
				// 			return "Zach's FIDE profile -> ratings.fide.com/profile/" + ZACH_FIDE_ID;
				// 		return `Zach's FIDE ratings (ratings.fide.com/profile/${ZACH_FIDE_ID}) -> ` +
				// 			player.ratings.filter(r => r.rating != "UNR").map(
				// 				r => emojis[r.category] + ` ${r.category} ${r.rating}`
				// 			).join(", ") + '.';
				// 	}
				// });

				this.programmable({
					commands: ["personalbest", "pb", "peak", "ath"], permissions: "all",
					description: "Gets Zach's peak ratings on Chess.com.",
					execute: async () => {
						const ratings = await Chess.com.best("thechessnerd");
						if (ratings === undefined)
							return "Zach's Chess.com profile -> chess.com/member/thechessnerd";
						return "Zach's Chess.com peak ratings -> " + ratings.map(
							r => emojis[r.category] + ` ${r.category} ${r.rating}`
						).join(", ") + '.';
					}
				});

				this.programmable({
					commands: ["puzzles"], permissions: "all",
					description: "Gets Chess.com puzzle stats for the specified user.",
					execute: async data => {
						const match = data.message.match(PUZZLES_REGEX);
						if (match === null || match.length < 2)
							return `Try with !chess.com <username>.`;
						const ratings = await Chess.com.puzzles(match[1]);
						if (ratings === undefined)
							return `Couldn't find Chess.com user '${match[1]}'.`;
						return saxon_genitive(match[1]) + " Chess.com puzzle stats -> " + ratings.map(
							r => emojis[r.category] + ` ${r.category} ${r.rating}`
						).join(", ") + '.';
					}
				});

				this.programmable({
					commands: ["chess.com", "chesscom", "ratings"], permissions: "all",
					description: "Gets Chess.com ratings for the specified user.",
					execute: async data => {
						try {
							const match = data.event.message.text.match(CHESS_COM_REGEX);
							if (match === null || match.length < 2) {
								const ratings = await Chess.com.ratings("thechessnerd");
								if (ratings === undefined)
									return "Zach's Chess.com profile -> chess.com/member/thechessnerd";
								return "Zach's Chess.com ratings -> " + ratings.map(
									r => emojis[r.category] + ` ${r.category} ${r.rating}`
								).join(", ") + '.';
							}
							const ratings = await Chess.com.ratings(match[1]);
							if (ratings === undefined)
								return `Couldn't find Chess.com user '${match[1]}'.`;
							return saxon_genitive(match[1]) + " Chess.com ratings -> " + ratings.map(
								r => emojis[r.category] + ` ${r.category} ${r.rating}`
							).join(", ") + '.';
						} catch (e) {
							console.log(e);
							console.error("Failed to get ratings");
						}
					}
				});

				this.programmable({
					commands: ["lichess", "lichess.org"], permissions: "all",
					description: "Gets lichess.org ratings for the specified user.",
					execute: async data => {
						const match = data.message.match(LICHESS_REGEX);
						if (match === null || match.length < 2)
							return `Try with !lichess <username>.`;
						const ratings = await lichess.org.ratings(match[1]);
						if (ratings === undefined)
							return `Couldn't find lichess.org user '${match[1]}'.`;
						return saxon_genitive(match[1]) + " lichess.org ratings -> " + ratings.map(
							r => emojis[r.category] + ` ${r.category} ${r.rating}`
						).join(", ") + '.';
					}
				});

				this.programmable({
					commands: ["starting"], permissions: "all",
					description: "Gets Zach's starting rating for this stream.",
					execute: async () => {
						const up = await uptime(this.Streamer); // NEED UPTIME!
						if (up === null) return 'Zach is not currently streaming.';
						// fetch the rating from the database.
						let ratings = await Database.get("starting_rating");
						if (ratings === undefined || ratings === null) {
							ratings = await Chess.com.ratings("thechessnerd");
							await Database.set("starting_rating", ratings);
						}
						if (ratings === undefined || ratings === null)
							return "Zach's Chess.com profile -> chess.com/member/thechessnerd";
						return "Zach's Chess.com starting rating for this stream -> " +
							ratings.map(
								r => emojis[r.category] + ` ${r.category} ${r.rating}`
							).join(", ") + '.';
					}
				});

				this.programmable({
					commands: ["video", "newvid", "newvideo"],
					description: "Gets Zach's current video link.",
					execute: async () => "Check out Zach's new YouTube video: " +
						(await Database.get("yt_video_title")) + " -> " +
						(await Database.get("yt_video_link"))
				});

				this.programmable({
					commands: ["votechess", "vc"],
					permissions: "all",
					description: "Vote Chess is where chat votes on a chess move, and the move that gets the most votes gets played!",
					execute: () => "Vote on moves to play! Type !vote, followed by your move! You only get 1 vote, and your most recent vote is what gets counted!"
				});

				this.programmable({
					commands: ["vcToggle", "vct"],
					permissions: "mod",
					description: "Toggle Vote Chess On or Off",
					execute: async () => {
						let toggle = await Database.get("vc_toggle");
						await Database.set("vc_toggle", !toggle);
						return `Vote Chess is now ${!toggle ? 'active' : 'closed'}.`;
					}
				});

				this.programmable({
					commands: ["vote"],
					permissions: "all",
					description: "Vote on a Chess move!",
					execute: async (data) => {
						try {
							let toggle = await Database.get("vc_toggle");
							if (!toggle) return "Vote Chess is not active!";
							let voting = await Database.get("voting");
							if (!voting) return "Voting hasn't started yet!";
							let user = data.event.chatter_user_name;
							let vote = data.event.message.text;
							vote = vote.substr(5).trim();
							if (vote.length > 6) return; // Don't think we will need votes longer than this

							// Checking if it is a legal move just by if it contains a chess square 
							let legal =
								[
									"a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8",
									"b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8",
									"c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8",
									"d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8",
									"e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8",
									"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8",
									"g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8",
									"h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8",
								]
							let votePass = false;

							for (const square of legal) {
								if (vote.includes(square)) votePass = true;
							}
							if (!votePass) return "Not a legal move!"
							await Database.set("vc_votes/" + user, vote);
							return;
						} catch (e) {
							console.log(e);
							console.error("Vote failed silently!");
						}

					}
				});

				this.programmable({
					commands: ["voteclear", "clearvotes", "resetvotes", "vclear"],
					permissions: "mod",
					description: "Clear all stored votes for Vote Chess",
					execute: async () => {
						let clear = {
							default: "empty"
						}
						await Database.set("vc_votes", clear);
						return "Votes have been cleared!"
					}
				});

				this.programmable({
					commands: ["votestart", "startvote", "vcstart"],
					permissions: "mod",
					description: "Starts a vote for Vote Chess, with the time in seconds for the vote to last. Defaults to 30 seconds.",
					execute: async (data) => {
						try {
							let toggle = await Database.get("vc_toggle");
							if (!toggle) return "Vote Chess is not active!";
							// If instance of AlarmTrigger class is needed to be accessed again, we CAN store the id/other data and recreate it out of this scope.
							// In the mean time, just handle the closing of the voting via the fetch logic /alarm
							let timer = data.event.message.text;
							timer = Number(timer.substr(5).trim());
							if (timer == 0 || Number.isNaN(timer)) timer = 30;
							const id = env.ALARMTRIGGER.idFromName("voting alarm");
							const stub = env.ALARMTRIGGER.get(id);

							await stub.start(timer);
							await Database.set("voting", true);
							return "Vote Started!"
						} catch (e) {
							console.log(e);
							console.log("Start vote failed");
						}
					}
				});
			}

			async endVote() {
				// Needs to disable voting
				// Count the votes
				// Display the top 3 votes and the votes for them
				try {
					await Database.set("voting", false);
					let votes = await Database.get("vc_votes");
					let countVotes = {};
					for (const user in votes) {
						let vote = votes[user];
						if (!countVotes[vote]) {
							countVotes[vote] = 1;
						} else {
							countVotes[vote]++;
						}
					}
					let countVotes1 = countVotes
					let values1 = Object.values(countVotes1).sort((a, b) => b - a);
					let maxN = values1[2];
					let values = Object.entries(countVotes).sort(([, a], [, b]) => b - a);
					values = values.filter((move) => move[1] >= maxN);
					const sortedVotes = Object.fromEntries(values);

					// console.log(sortedVotes);
					// console.log("Vote Ended Successfully");

					let msg = `The top Votes were: ................................................................... `
					for (let i = 0; i < values.length; i++) {
						let text = values[i][1] > 1 ? "votes" : "vote";
						msg = `${msg} ${i + 1}. ${values[i][0]} with ${values[i][1]} ${text} ......................... ...................  `
					}

					let clear = {
						default: "empty"
					}
					await Database.set("vc_votes", clear);
					return msg
				} catch (e) {
					console.log(e)
					console.error("End Vote Failed");
				}

				return;
			}
		}

		const url = new URL(request.url);
		let chat = new TwitchChat;
		let chatData = {};
		let msgCount = 0;
		//await chat.validate(); // should be replaced with a chron alarm (validate every hour!)

		switch (request.method) {
			case "POST":
				switch (url.pathname) {
					case '/alarm':
						let voteMsg = await chat.endVote();
						await chat.chat(voteMsg);
						return new Response('Post Alarm!');
					case '/refresh':
						// await chat.validate();  This is here because we ~should~ be validating every hour or so, but if we're refreshing that soon then whats the point?
						// Could alternatively check for the expiration time of the token and only call chat.twitchRefresh() upon reaching a certain threshold ~ < 1hr. #TODO

						// has a scheduled chron event (see below) so ideally it should validate every hour now.
						await chat.validate();
						return new Response('Refresh!');
					case '/queue':
						return new Response('Queue!');
					case '/validate':
						await chat.validate();
						return new Response('Validate!');
					case '/connect':
						return new Response('Connect!');
					case '/ext':
						return new Response('Extension!');
					case '/callback':
						const clone = request.clone();
						let test = await chat.notification(request);
						let req = await clone.json();

						let msg = req.event.message // This was initially to count messages and verify message handling wasn't done multiple times
						let msgText = msg.text // Can maybe use Durable Object if I wanted to verify?

						chatData[msgCount] = req;
						msgCount++;

						return new Response(test, { status: 200 });
					case '/init':
						await chat.init();
						return new Response('init!');
					default:
						return new Response('Not Found', { status: 404 });
				}
			case "GET":
				switch (url.pathname) {
					case '/alarm':
						console.log("alarmed get");
						await chat.endVote();
						return new Response('Get Alarm!');
					case '/mod':
						return new Response('Mod!');
					case '/queue':
						return new Response('Queue!');
					case '/validate':
						await chat.validate();
						return new Response('Validate!');
					case '/connect':
						return new Response('Connect!');
					case '/ext':
						return new Response('Extension!');
					case '/random':
						return new Response(crypto.randomUUID());
					case '/message':
						let mesRes = {
							headers: new Headers({ "Content-Type": "text/html" })
						}
						return new Response(subHTML, mesRes);
					case '/callback':
						return new Response("Callback!");
					case '/init':
						let subRes = await chat.init();
						return new Response(JSON.stringify(subRes));
					case '/test':
						let list = await chat.getSubscriptions();
						let items = list.data;
						let newHTML = subHTML.replace("`%LIST%`", JSON.stringify(items));
						let res = {
							headers: new Headers({ "Content-Type": "text/html" }),
							body: JSON.stringify(newHTML)
						};
						return new Response(res);
					case '/getSubs':
						let subs = await chat.getSubscriptions();
						return new Response(JSON.stringify(subs));
					case '/delete':
						await chat.deleteAll()
						return new Response("Deleted");
					case '/chat':
						return new Response(chatHTML);
					case '/data':
						// can store a list of all messages in an obj
						// send all messages as data upon a get
						// compare with list of messages the client already has
						// which can be determined by having the client send those on the request
						// only send the updated messages

						return new Response(JSON.stringify(chatData));
					case '/refresh':
						// await chat.validate();  This is here because we ~should~ be validating every hour or so, but if we're refreshing that soon then whats the point?
						// Could alternatively check for the expiration time of the token and only call chat.twitchRefresh() upon reaching a certain threshold ~ < 1hr. #TODO

						// has a scheduled chron event (see below) so ideally it should validate every hour now.
						await chat.validate();
						return new Response('Refresh!');
					default:
						return new Response('Not Found', { status: 404 });
				}
			default:
				return new Response('Not Found', { status: 404 });
		}

	},

	async scheduled(event, env, ctx) {
		switch (event.cron) {
			case "0 * * * *":
				await this.fetch("https://cloudflare-en-passant.chanceloricco-chessnerd.workers.dev/refresh");
		}
	}
};



class Chess {

	static com = {

		profile: async user => {
			user = encodeURIComponent(user);
			const url = 'https://api.chess.com/pub/player/';
			try {
				const response = await fetch(url + user);
				if (response.status != 200) return null;
				return await response.json();
			} catch { return null; }
		},

		stats: async user => {
			try {
				console.log("Getting " + user + " stats");
				user = encodeURIComponent(user);
				const url = `https://api.chess.com/pub/player/${user}/stats`;
				const headers = {
					"User-Agent": "En-passant/1.0 (contact: chanceloricco+chessnerd@gmail.com; project: https://github.com/senti3ntb3ing/cloudflare-en-passant)",
					"Accept": "application/json",
					"Referer": "https://cloudflare-en-passant.chanceloricco-chessnerd.workers.dev/",
					"Origin": "https://cloudflare-en-passant.chanceloricco-chessnerd.workers.dev/",
				}
				const response = await fetch(url, headers);
				console.log(await response.text());
				console.log(response.status)
				if (response.status != 200) {
					console.log(response.status);
					return null;
				}
				return await response.json();
			} catch (e) {
				console.log(e);
				console.error("Failed getting stats from Chess.com!");
				return null;
			}
		},

		ratings: async user => {
			const categories = ['rapid', 'blitz', 'bullet'];
			const ratings = [];
			try {
				const chess_com = await Chess.com.stats(user);
				console.log("Here! Chess COM!!!!");
				if (chess_com == null) return undefined;
				for (const category of categories) {
					const key = 'chess_' + category;
					if (chess_com[key] == undefined ||
						chess_com[key].last == undefined ||
						chess_com[key].last.rating == undefined) continue;
					const rating = { category, rating: 'unrated' };
					if (!isNaN(parseInt(chess_com[key].last.rating)))
						rating.rating = chess_com[key].last.rating;
					ratings.push(rating);
				}
				return ratings;
			} catch (e) {
				console.log(e);
				console.error("Failed to get ratings from Chess.com");
			}
		},

		best: async user => {
			const categories = ['rapid', 'blitz', 'bullet'];
			const ratings = [];
			const chess_com = await Chess.com.stats(user);
			if (chess_com == null) return undefined;
			for (const category of categories) {
				const key = 'chess_' + category;
				if (chess_com[key] == undefined ||
					chess_com[key].best == undefined ||
					chess_com[key].best.rating == undefined) continue;
				const rating = { category, rating: 'unrated' };
				if (!isNaN(parseInt(chess_com[key].best.rating)))
					rating.rating = chess_com[key].best.rating;
				ratings.push(rating);
			}
			return ratings;
		},

		puzzles: async user => {
			const ratings = [];
			const chess_com = await Chess.com.stats(user);
			if (chess_com == null) return undefined;
			if (chess_com['tactics'] != undefined &&
				chess_com['tactics'].highest != undefined &&
				chess_com['tactics'].highest.rating != undefined &&
				!isNaN(parseInt(chess_com['tactics'].highest.rating))) ratings.push({
					category: 'tactics', rating: chess_com['tactics'].highest.rating
				});
			if (chess_com['puzzle_rush'] != undefined &&
				chess_com['puzzle_rush'].best != undefined &&
				chess_com['puzzle_rush'].best.score != undefined &&
				!isNaN(parseInt(chess_com['puzzle_rush'].best.score))) ratings.push({
					category: 'puzzle rush', rating: chess_com['puzzle_rush'].best.score
				});
			return ratings;
		},

		exists: async user => {
			user = encodeURIComponent(user);
			const url = `https://api.chess.com/pub/player/${user}/stats`;
			try {
				const response = await fetch(url);
				return (response.status == 200);
			} catch { return false; }
		},

		/// gets daily game from chess.com given its
		/// id returns undefined in case of error.
		daily: async id => {
			const API_BASE_URL = 'https://www.chess.com/callback/daily/game/';
			let g = undefined;
			try {
				g = await fetch(API_BASE_URL + id).then(
					r => r.status == 200 ? r.json() : undefined
				);
			} catch { return undefined; }
			if (g == undefined) return undefined;
			g.game.moveList = moves(g.game.moveList);
			return g.game;
		},

		/// gets live game from chess.com given its
		/// id returns undefined in case of error.
		live: async id => {
			const API_BASE_URL = 'https://www.chess.com/callback/live/game/';
			let g = undefined;
			try {
				g = await fetch(API_BASE_URL + id).then(
					r => r.status == 200 ? r.json() : undefined
				);
			} catch { return undefined; }
			if (g == undefined) return undefined;
			g.game.moveList = moves(g.game.moveList);
			return g.game;
		}

	};

}

// MOVES:

// https://github.com/andyruwruw/chess-web-api/issues/10#issuecomment-779735204
const S = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?';
const FILES = 'abcdefgh';

// https://github.com/andyruwruw/chess-web-api/issues/11#issuecomment-783687021
const PROMOTIONS = '#@$_[]^()~{}';
const PIECES = 'brnq';

/// decodes a move into algebraic notation or pawn promotion.
/// - move: string of two characters.
function decode(move) {
	let index = S.indexOf(move[0]);
	const f1 = FILES[index % 8], r1 = Math.floor(index / 8) + 1;
	index = S.indexOf(move[1]);
	let p, f2, r2;
	if (index == -1) {
		index = PROMOTIONS.indexOf(move[1]);
		p = PIECES[Math.floor(index / 3)];
		f2 = FILES.indexOf(f1);
		const l = index % 3 == 1, r = index % 3 == 2;
		if (l) f2--; else if (r) f2++; // capture left or right
		f2 = FILES[f2];
		if (r1 == 2) r2 = 1; else r2 = 8;
	} else { f2 = FILES[index % 8]; r2 = Math.floor(index / 8) + 1; }
	return { from: `${f1}${r1}`, to: `${f2}${r2}`, promotion: p };
}

/// decodes a list of moves from a string.
function moves(m) {
	const list = [];
	for (let i = 0; i < m.length; i += 2) {
		const move = decode(m.substring(i, i + 2));
		list.push(move);
	}
	return list;
}

class lichess {

	static org = {

		profile: async user => {
			user = encodeURIComponent(user);
			const url = 'https://lichess.org/api/user/';
			try {
				const response = await fetch(url + user);
				if (response.status != 200) return null;
				return await response.json();
			} catch { return null; }
		},

		ratings: async user => {
			const categories = ['classical', 'rapid', 'blitz', 'bullet'];
			const ratings = [];
			const l = await lichess.org.profile(user);
			if (l == null || l.perfs == undefined) return undefined;
			for (const category of categories) {
				if (l.perfs[category] == undefined ||
					l.perfs[category].rating == undefined) continue;
				const rating = { category, rating: 'unrated' };
				if (!isNaN(parseInt(l.perfs[category].rating)))
					rating.rating = l.perfs[category].rating;
				ratings.push(rating);
			}
			return ratings;
		}

	}

}
import { DurableObject } from "cloudflare:workers";

export class AlarmTrigger extends DurableObject {
	constructor(state, env) {
		super(state, env);
		this.state = state;
		this.storage = state.storage;
	}

	async start(timer) {
		let currentAlarm = await this.storage.getAlarm();
		if (currentAlarm == null) this.storage.setAlarm(Date.now() + 1000 * timer);
	}

	async alarm() {
		console.log("Alarm Triggered");
		let response = await fetch("https://cloudflare-en-passant.chanceloricco-chessnerd.workers.dev/alarm", {
			method: "POST",
			headers: { "Content-Type": "application/json" }
		});
		console.log(await response.text());
	}

}

