import { type WebSocket } from "uWebSockets.js";
import { GameConstants, KillFeedMessageType, KillType, ObjectCategory, PacketType } from "../../common/src/constants";
import { type ExplosionDefinition } from "../../common/src/definitions/explosions";
import { type LootDefinition } from "../../common/src/definitions/loots";
import { Obstacles, type ObstacleDefinition } from "../../common/src/definitions/obstacles";
import { InputPacket } from "../../common/src/packets/inputPacket";
import { JoinPacket } from "../../common/src/packets/joinPacket";
import { JoinedPacket } from "../../common/src/packets/joinedPacket";
import { PingPacket } from "../../common/src/packets/pingPacket";
import { SpectatePacket } from "../../common/src/packets/spectatePacket";
import { type KillFeedMessage } from "../../common/src/packets/updatePacket";
import { CircleHitbox } from "../../common/src/utils/hitbox";
import { Geometry, Numeric } from "../../common/src/utils/math";
import { Timeout } from "../../common/src/utils/misc";
import { ItemType, MapObjectSpawnMode, type ReferenceTo, type ReifiableDef } from "../../common/src/utils/objectDefinitions";
import { ObjectPool } from "../../common/src/utils/objectPool";
import { randomPointInsideCircle, randomRotation } from "../../common/src/utils/random";
import { OBJECT_ID_BITS, type SuroiBitStream } from "../../common/src/utils/suroiBitStream";
import { Vec, type Vector } from "../../common/src/utils/vector";
import { Config, SpawnMode } from "./config";
import { Maps } from "./data/maps";
import { Gas } from "./gas";
import { type GunItem } from "./inventory/gunItem";
import { Map } from "./map";
import { Building } from "./objects/building";
import { Bullet, type DamageRecord, type ServerBulletOptions } from "./objects/bullet";
import { type DeathMarker } from "./objects/deathMarker";
import { type Decal } from "./objects/decal";
import { type Emote } from "./objects/emote";
import { Explosion } from "./objects/explosion";
import { type GameObject } from "./objects/gameObject";
import { Loot } from "./objects/loot";
import { Obstacle } from "./objects/obstacle";
import { Parachute } from "./objects/parachute";
import { Player } from "./objects/player";
import { endGame, newGame, type PlayerContainer } from "./server";
import { hasBadWords } from "./utils/badWordFilter";
import { Grid } from "./utils/grid";
import { IDAllocator } from "./utils/idAllocator";
import { Logger, removeFrom } from "./utils/misc";

interface ObjectMapping {
    [ObjectCategory.Player]: Player
    [ObjectCategory.Obstacle]: Obstacle
    [ObjectCategory.DeathMarker]: DeathMarker
    [ObjectCategory.Loot]: Loot
    [ObjectCategory.Building]: Building
    [ObjectCategory.Decal]: Decal
    [ObjectCategory.Parachute]: Parachute
}

export class Game {
    readonly _id: number;
    get id(): number { return this._id; }

    map: Map;

    gas: Gas;

    readonly grid: Grid<GameObject>;

    readonly partialDirtyObjects = new Set<GameObject>();
    readonly fullDirtyObjects = new Set<GameObject>();

    updateObjects = false;

    readonly objects = new ObjectPool<ObjectMapping>();

    readonly livingPlayers: Set<Player> = new Set<Player>();
    readonly connectedPlayers: Set<Player> = new Set<Player>();
    readonly spectatablePlayers: Player[] = [];
    /**
     * New players created this tick
     */
    readonly newPlayers: Set<Player> = new Set<Player>();
    /**
    * Players deleted this tick
    */
    readonly deletedPlayers: Set<number> = new Set<number>();

    readonly explosions: Set<Explosion> = new Set<Explosion>();
    readonly emotes: Set<Emote> = new Set<Emote>();
    readonly parachutes = new Set<Parachute>();

    /**
     * All bullets that currently exist
     */
    readonly bullets = new Set<Bullet>();
    /**
     * All bullets created this tick
     */
    readonly newBullets = new Set<Bullet>();

    /**
     * All kill feed messages this tick
     */
    readonly killFeedMessages = new Set<KillFeedMessage>();

    /**
     * All airdrops
     */
    readonly airdrops = new Set<Airdrop>();

    /**
     * All planes this tick
     */
    readonly planes = new Set<{ position: Vector, direction: number }>();

    /**
     * All map pings this tick
     */
    readonly mapPings = new Set<Vector>();

    private readonly _timeouts = new Set<Timeout>();

    addTimeout(callback: () => void, delay?: number): Timeout {
        const timeout = new Timeout(callback, this.now + (delay ?? 0));
        this._timeouts.add(timeout);
        return timeout;
    }

    private _started = false;
    allowJoin = false;
    over = false;
    stopped = false;

    startedTime = Number.MAX_VALUE; // Default of Number.MAX_VALUE makes it so games that haven't started yet are joined first

    startTimeout?: Timeout;

    aliveCountDirty = false;

    /**
     * The value of `Date.now()`, as of the start of the tick.
     */
    private _now = Date.now();
    get now(): number { return this._now; }

    tickTimes: number[] = [];

    constructor(id: number) {
        this._id = id;

        const start = Date.now();

        // Generate map
        this.grid = new Grid(Maps[Config.mapName].width, Maps[Config.mapName].height);
        this.map = new Map(this, Config.mapName);

        this.gas = new Gas(this);

        this.allowJoin = true;

        Logger.log(`Game ${this.id} | Created in ${Date.now() - start} ms`);

        // Start the tick loop
        this.tick(GameConstants.msPerTick);
    }

    handlePacket(stream: SuroiBitStream, player: Player): void {
        switch (stream.readPacketType()) {
            case PacketType.Join: {
                if (player.joined) return;
                const packet = new JoinPacket();
                packet.deserialize(stream);
                this.activatePlayer(player, packet);
                break;
            }
            case PacketType.Input: {
                // Ignore input packets from players that haven't finished joining, dead players, and if the game is over
                if (!player.joined || player.dead || player.game.over) return;

                const packet = new InputPacket();
                packet.isMobile = player.isMobile;
                packet.deserialize(stream);
                player.processInputs(packet);
                break;
            }
            case PacketType.Spectate: {
                const packet = new SpectatePacket();
                packet.deserialize(stream);
                player.spectate(packet);
                break;
            }
            case PacketType.Ping: {
                if (Date.now() - player.lastPingTime < 4000) return;
                player.lastPingTime = Date.now();
                player.sendPacket(new PingPacket());
                break;
            }
        }
    }

    tick(delay: number): void {
        setTimeout((): void => {
            this._now = Date.now();

            if (this.stopped) return;

            // execute timeouts
            for (const timeout of this._timeouts) {
                if (timeout.killed) {
                    this._timeouts.delete(timeout);
                    continue;
                }

                if (this.now > timeout.end) {
                    timeout.callback();
                    this._timeouts.delete(timeout);
                }
            }

            // Update loots
            for (const loot of this.objects.getCategory(ObjectCategory.Loot)) {
                loot.update();
            }

            for (const parachute of this.objects.getCategory(ObjectCategory.Parachute)) {
                parachute.update();
            }

            // Update bullets
            let records: DamageRecord[] = [];
            for (const bullet of this.bullets) {
                records = records.concat(bullet.update());

                if (bullet.dead) {
                    if (bullet.definition.onHitExplosion && !bullet.reflected) {
                        this.addExplosion(bullet.definition.onHitExplosion, bullet.position, bullet.shooter);
                    }
                    this.bullets.delete(bullet);
                }
            }

            // Do the damage after updating all bullets
            // This is to make sure bullets that hit the same object on the same tick will die so they don't de-sync with the client
            // Example: a shotgun insta killing a crate, in the client all bullets will hit the crate
            // while on the server, without this, some bullets won't because the first bullets will kill the crate
            for (const { object, damage, source, weapon, position } of records) {
                object.damage(damage, source, weapon, position);
            }

            // Handle explosions
            for (const explosion of this.explosions) {
                explosion.explode();
            }

            // Update gas
            this.gas.tick();

            // First loop over players: Movement, animations, & actions
            for (const player of this.objects.getCategory(ObjectCategory.Player)) {
                if (!player.dead) player.update();
                player.thisTickDirty = JSON.parse(JSON.stringify(player.dirty));
            }

            // Second loop over players: calculate visible objects & send updates
            for (const player of this.connectedPlayers) {
                if (!player.joined) continue;

                player.secondUpdate();
            }

            // Reset everything
            this.fullDirtyObjects.clear();
            this.partialDirtyObjects.clear();
            this.newBullets.clear();
            this.explosions.clear();
            this.emotes.clear();
            this.newPlayers.clear();
            this.deletedPlayers.clear();
            this.killFeedMessages.clear();
            this.planes.clear();
            this.mapPings.clear();
            this.aliveCountDirty = false;
            this.gas.dirty = false;
            this.gas.completionRatioDirty = false;
            this.updateObjects = false;

            // Winning logic
            if (this._started && this.aliveCount < 2 && !this.over) {
                // Send game over packet to the last man standing
                if (this.aliveCount === 1) {
                    const lastManStanding = [...this.livingPlayers][0];
                    lastManStanding.movement.up = false;
                    lastManStanding.movement.down = false;
                    lastManStanding.movement.left = false;
                    lastManStanding.movement.right = false;
                    lastManStanding.attacking = false;
                    lastManStanding.sendGameOverPacket(true);
                }

                // End the game in 1 second
                // If allowJoin is true, then a new game hasn't been created by this game, so create one to replace this one
                const shouldCreateNewGame = this.allowJoin;
                this.allowJoin = false;
                this.over = true;

                this.addTimeout(() => endGame(this._id, shouldCreateNewGame), 1000);
            }

            // Record performance and start the next tick
            // THIS TICK COUNTER IS WORKING CORRECTLY!
            // It measures the time it takes to calculate a tick, not the time between ticks.
            const tickTime = Date.now() - this.now;
            this.tickTimes.push(tickTime);

            if (this.tickTimes.length >= 200) {
                const mspt = this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length;

                Logger.log(`Game ${this._id} | Avg ms/tick: ${mspt.toFixed(2)} | Load: ${((mspt / GameConstants.msPerTick) * 100).toFixed(1)}%`);
                this.tickTimes = [];
            }

            this.tick(Math.max(0, GameConstants.msPerTick - tickTime));
        }, delay);
    }

    private _killLeader: Player | undefined;
    get killLeader(): Player | undefined { return this._killLeader; }

    updateKillLeader(player: Player): void {
        const oldKillLeader = this._killLeader;

        if (player.kills > (this._killLeader?.kills ?? (GameConstants.player.killLeaderMinKills - 1)) && !player.dead) {
            this._killLeader = player;

            if (oldKillLeader !== this._killLeader) {
                this._sendKillFeedMessage(KillFeedMessageType.KillLeaderAssigned);
            }
        } else if (player === oldKillLeader) {
            this._sendKillFeedMessage(KillFeedMessageType.KillLeaderUpdated);
        }
    }

    killLeaderDead(killer?: Player): void {
        this._sendKillFeedMessage(KillFeedMessageType.KillLeaderDead, { killType: KillType.TwoPartyInteraction, killerID: killer?.id });
        let newKillLeader: Player | undefined;
        for (const player of this.livingPlayers) {
            if (player.kills > (newKillLeader?.kills ?? (GameConstants.player.killLeaderMinKills - 1)) && !player.dead) {
                newKillLeader = player;
            }
        }
        this._killLeader = newKillLeader;
        this._sendKillFeedMessage(KillFeedMessageType.KillLeaderAssigned);
    }

    private _sendKillFeedMessage(messageType: KillFeedMessageType, options?: Partial<Omit<KillFeedMessage, "messageType" | "playerID" | "kills">>): void {
        if (this._killLeader === undefined) return;
        this.killFeedMessages.add({
            messageType,
            playerID: this._killLeader.id,
            kills: this._killLeader.kills,
            ...options
        });
    }

    addPlayer(socket: WebSocket<PlayerContainer>): Player {
        let spawnPosition = Vec.create(this.map.width / 2, this.map.height / 2);
        const hitbox = new CircleHitbox(5);
        switch (Config.spawn.mode) {
            case SpawnMode.Normal: {
                const gasRadius = this.gas.newRadius ** 2;
                let foundPosition = false;
                let tries = 0;
                while (!foundPosition && tries < 100) {
                    spawnPosition = this.map.getRandomPosition(hitbox, {
                        maxAttempts: 500,
                        spawnMode: MapObjectSpawnMode.GrassAndSand,
                        collides: (position) => {
                            return Geometry.distanceSquared(position, this.gas.currentPosition) >= gasRadius;
                        }
                    }) ?? spawnPosition;

                    const radiusHitbox = new CircleHitbox(50, spawnPosition);
                    for (const object of this.grid.intersectsHitbox(radiusHitbox)) {
                        if (object instanceof Player) {
                            foundPosition = false;
                        }
                    }
                    tries++;
                }
                break;
            }
            case SpawnMode.Random: {
                const gasRadius = this.gas.newRadius ** 2;
                spawnPosition = this.map.getRandomPosition(hitbox, {
                    maxAttempts: 500,
                    spawnMode: MapObjectSpawnMode.GrassAndSand,
                    collides: (position) => {
                        return Geometry.distanceSquared(position, this.gas.currentPosition) >= gasRadius;
                    }
                }) ?? spawnPosition;
                break;
            }
            case SpawnMode.Radius: {
                spawnPosition = randomPointInsideCircle(
                    Config.spawn.position,
                    Config.spawn.radius
                );
                break;
            }
            case SpawnMode.Fixed: {
                spawnPosition = Config.spawn.position;
                break;
            }
            // No case for SpawnMode.Center because that's the default
        }
        // Player is added to the players array when a JoinPacket is received from the client
        return new Player(this, socket, spawnPosition);
    }

    // Called when a JoinPacket is sent by the client
    activatePlayer(player: Player, packet: JoinPacket): void {
        let name = packet.name;
        if (
            name.length === 0 ||
            (Config.censorUsernames && hasBadWords(name)) ||
            // eslint-disable-next-line no-control-regex
            /[^\x00-\x7F]/g.test(name) // extended ASCII chars
        ) name = GameConstants.player.defaultName;
        player.name = name;

        player.isMobile = packet.isMobile;
        const skin = packet.skin;
        if (
            skin.itemType === ItemType.Skin &&
            !skin.notInLoadout &&
            (skin.roleRequired === undefined || skin.roleRequired === player.role)
        ) {
            player.loadout.skin = skin;
        }
        player.loadout.emotes = packet.emotes;

        this.livingPlayers.add(player);
        this.objects.add(player);
        this.spectatablePlayers.push(player);
        this.connectedPlayers.add(player);
        this.newPlayers.add(player);
        this.grid.addObject(player);
        this.fullDirtyObjects.add(player);
        this.aliveCountDirty = true;
        this.updateObjects = true;

        player.joined = true;

        const joinedPacket = new JoinedPacket();
        joinedPacket.emotes = player.loadout.emotes;
        player.sendPacket(joinedPacket);

        player.sendData(this.map.buffer);

        this.addTimeout(() => { player.disableInvulnerability(); }, 5000);

        if (this.aliveCount > 1 && !this._started && this.startTimeout === undefined) {
            this.startTimeout = this.addTimeout(() => {
                this._started = true;
                this.startedTime = this.now;
                this.gas.advanceGasStage();

                this.addTimeout(() => {
                    newGame();
                    Logger.log(`Game ${this.id} | Preventing new players from joining`);
                    this.allowJoin = false;
                }, Config.preventJoinAfter);
            }, 3000);
        }

        Logger.log(`Game ${this.id} | "${player.name}" joined`);
    }

    removePlayer(player: Player): void {
        player.disconnected = true;
        this.aliveCountDirty = true;
        this.connectedPlayers.delete(player);

        if (player.canDespawn) {
            this.livingPlayers.delete(player);
            this.removeObject(player);
            this.deletedPlayers.add(player.id);
            removeFrom(this.spectatablePlayers, player);
        } else {
            player.rotation = 0;
            player.movement.up = player.movement.down = player.movement.left = player.movement.right = false;
            player.attacking = false;
            this.partialDirtyObjects.add(player);
        }

        if (player.spectating !== undefined) {
            player.spectating.spectators.delete(player);
        }

        if (this.aliveCount < 2) {
            this.startTimeout?.kill();
            this.startTimeout = undefined;
        }

        try {
            player.socket.close();
        } catch (e) { }
    }

    /**
     * Adds a `Loot` item to the game world
     * @param definition The type of loot to add. Prefer passing `LootDefinition` if possible
     * @param position The position to spawn this loot at
     * @param count Optionally define an amount of this loot (note that this does not equate spawning
     * that many `Loot` objects, but rather how many the singular `Loot` object will contain)
     * @returns The created loot object
     */
    addLoot(definition: ReifiableDef<LootDefinition>, position: Vector, count?: number): Loot {
        const loot = new Loot(
            this,
            definition,
            position,
            count
        );

        this.objects.add(loot);
        this.grid.addObject(loot);
        return loot;
    }

    removeLoot(loot: Loot): void {
        loot.dead = true;
        this.removeObject(loot);
    }

    addBullet(source: GunItem | Explosion, shooter: GameObject, options: ServerBulletOptions): Bullet {
        const bullet = new Bullet(
            this,
            source,
            shooter,
            options
        );

        this.bullets.add(bullet);
        this.newBullets.add(bullet);

        return bullet;
    }

    addExplosion(type: ReferenceTo<ExplosionDefinition> | ExplosionDefinition, position: Vector, source: GameObject): Explosion {
        const explosion = new Explosion(this, type, position, source);
        this.explosions.add(explosion);
        return explosion;
    }

    /**
     * Delete an object and give the id back to the allocator
     * @param object The object to delete
     */
    removeObject(object: GameObject): void {
        this.grid.removeObject(object);
        this.idAllocator.give(object.id);
        this.updateObjects = true;
        this.objects.delete(object as ObjectMapping[ObjectCategory]);
    }

    summonAirdrop(position: Vector): void {
        const crateDef = Obstacles.fromString("airdrop_crate_locked");
        const crateHitbox = (crateDef.spawnHitbox ?? crateDef.hitbox).clone();
        let thisHitbox = crateHitbox.clone();

        let collided = true;
        let attempts = 0;

        while (collided && attempts < 500) {
            attempts++;
            collided = false;

            for (const airdrop of this.airdrops) {
                thisHitbox = crateHitbox.transform(position);
                const thatHitbox = (airdrop.type.spawnHitbox ?? airdrop.type.hitbox).transform(airdrop.position);

                if (thisHitbox.collidesWith(thatHitbox)) {
                    collided = true;
                    thisHitbox.resolveCollision(thatHitbox);
                }
                position = thisHitbox.getCenter();
                if (collided) break;
            }

            thisHitbox = crateHitbox.transform(position);

            for (const object of this.grid.intersectsHitbox(thisHitbox)) {
                if (object instanceof Obstacle &&
                    !object.dead &&
                    object.definition.indestructible &&
                    object.spawnHitbox.collidesWith(thisHitbox)) {
                    collided = true;
                    thisHitbox.resolveCollision(object.spawnHitbox);
                }
                position = thisHitbox.getCenter();
            }

            // second loop, buildings
            for (const object of this.grid.intersectsHitbox(thisHitbox)) {
                if (object instanceof Building &&
                    object.scopeHitbox &&
                    object.definition.wallsToDestroy === undefined) {
                    const hitbox = object.scopeHitbox.clone();
                    hitbox.scale(1.5);
                    if (!thisHitbox.collidesWith(hitbox)) continue;
                    collided = true;
                    thisHitbox.resolveCollision(object.scopeHitbox);
                }
                position = thisHitbox.getCenter();
            }

            const { min, max } = thisHitbox.toRectangle();
            const width = max.x - min.x;
            const height = max.y - min.y;
            position.x = Numeric.clamp(position.x, width, this.map.width - width);
            position.y = Numeric.clamp(position.y, height, this.map.height - height);
        }

        const direction = randomRotation();

        const planePos = Vec.add(
            position,
            Vec.fromPolar(direction, -GameConstants.maxPosition)
        );

        const airdrop = { position, type: crateDef };

        this.airdrops.add(airdrop);

        this.planes.add({ position: planePos, direction });

        this.addTimeout(
            () => {
                const parachute = new Parachute(this, position, airdrop);
                this.grid.addObject(parachute);
                this.objects.add(parachute);
                this.mapPings.add(position);
            },
            GameConstants.airdrop.flyTime
        );
    }

    get aliveCount(): number {
        return this.livingPlayers.size;
    }

    idAllocator = new IDAllocator(OBJECT_ID_BITS);

    get nextObjectID(): number {
        return this.idAllocator.takeNext();
    }
}

export interface Airdrop {
    readonly position: Vector
    readonly type: ObstacleDefinition
}
