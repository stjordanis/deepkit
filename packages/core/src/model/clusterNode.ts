/*
 * Copyright (c) Marc J. Schmidt <marc@marcjschmidt.de>
 * This file is part of Deepkit and licensed under GNU GPL v3. See the LICENSE file for more information.
 */

import {
    Entity,
    f,
    uuid,
    cloneClass,
} from '@marcj/marshal';
import {JobAssignedResources, JobAssignedResourcesGpu, JobResources} from "./job";
import {IdInterface} from "@marcj/glut-core";

export class NodeGpuResource {
    @f
    reserved: boolean = false;

    /**
     * Value in GB.
     */
    @f
    memory: number = 1;

    constructor(
        @f.asName('uuid') public uuid: string,
        @f.asName('name') public name: string,
    ) {
    }
}

export class NodeResourceReservation {
    @f
    reserved: number = 0;

    @f
    total: number = 0;
}

export function getJobTaskInstanceId(jobId: string, taskName: string, instanceId: number): string {
    return jobId + '.' + instanceId + '.' + taskName;
}

export function getJobTaskInstanceIdForAssignedJobTaskInstance(assignedJobTaskInstance: AssignedJobTaskInstance): string {
    return getJobTaskInstanceId(assignedJobTaskInstance.jobId, assignedJobTaskInstance.taskName, assignedJobTaskInstance.instance);
}

@Entity('AssignedJobTaskInstance')
export class AssignedJobTaskInstance {
    constructor(
        @f.asName('jobId') public jobId: string,
        @f.asName('jobAccessToken') public jobAccessToken: string,
        @f.asName('taskName') public taskName: string,
        @f.asName('instance') public instance: number,
        @f.asName('assignedResources') public assignedResources: JobAssignedResources,
    ) {}
}

@Entity('nodeResources')
export class NodeResources {
    @f
    cpu: NodeResourceReservation = new NodeResourceReservation;

    @f
    memory: NodeResourceReservation = new NodeResourceReservation;

    @f.array(NodeGpuResource)
    gpu: NodeGpuResource[] = [];

    @f.map(AssignedJobTaskInstance)
    assignedJobTaskInstances: { [taskInstanceId: string]: AssignedJobTaskInstance } = {};

    public free(jobId: string, taskName: string, instanceId: number) {
        const id = getJobTaskInstanceId(jobId, taskName, instanceId);

        if (!this.assignedJobTaskInstances[id]) {
            return;
        }

        const resources = this.assignedJobTaskInstances[id].assignedResources;

        delete this.assignedJobTaskInstances[id];
        this.cpu.reserved -= resources.cpu;
        this.memory.reserved -= resources.memory;

        for (const assignedGpu of resources.gpus) {
            const gpu = this.getGpu(assignedGpu.uuid);
            if (!gpu) continue;
            gpu.reserved = false;
        }
    }

    public reserveAssignment(
        jobId: string,
        jobAccessToken: string,
        taskName: string,
        instanceId: number,
        a: JobAssignedResources
    ) {
        const id = getJobTaskInstanceId(jobId, taskName, instanceId);

        if (this.assignedJobTaskInstances[id]) {
            throw new Error(`Task instance already reserved.`);
        }

        this.assignedJobTaskInstances[id] = new AssignedJobTaskInstance(
            jobId, jobAccessToken, taskName, instanceId, a
        );

        this.cpu.reserved += a.cpu;
        this.memory.reserved += a.memory;

        for (const gpu of a.gpus) {
            const ourGpu = this.getGpu(gpu.uuid);
            if (ourGpu) {
                ourGpu.reserved = true;
            }
        }
    }

    hasAssignedJobs() {
        return Object.keys(this.assignedJobTaskInstances).length > 0;
    }

    public clearReservations() {
        this.cpu.reserved = 0;
        this.memory.reserved = 0;
        this.assignedJobTaskInstances = {};

        const gpus: NodeGpuResource[] = [];
        for (const ourGpu of this.gpu) {
            const copy = cloneClass(ourGpu);
            copy.reserved = false;
            gpus.push(copy);
        }
        this.gpu = gpus;
    }

    /**
     * This only consumes resources, mainly used by the algorithm that detects which nodes are free.
     * This does not reserve the actual task instance.
     */
    public consume(resources: JobResources): JobAssignedResources {
        let cpu = 1;
        let memory = 1;
        let gpu = 0;

        resources.normalizeValues();

        const freeCpu = this.cpu.total - this.cpu.reserved;
        if (resources.cpu) {
            if (resources.cpu > freeCpu) {
                throw new Error(`Could not reserve cpu ${resources.cpu}, since only ${freeCpu} free.`);
            }
            cpu = resources.cpu;
        } else {
            let reserveCpu = resources.getMinCpu();
            if (reserveCpu > freeCpu) {
                throw new Error(`Could not reserve cpu ${reserveCpu}, since only ${freeCpu} free.`);
            }
            if (resources.maxCpu > 0) {
                reserveCpu = Math.min(freeCpu, resources.maxCpu);
            } else {
                reserveCpu = freeCpu;
            }
            cpu = reserveCpu;
        }

        const freeMemory = this.memory.total - this.memory.reserved;
        if (resources.memory) {
            if (resources.memory > freeMemory) {
                throw new Error(`Could not reserve memory ${resources.memory}, since only ${freeMemory} free.`);
            }
            memory = resources.memory;
        } else {
            let reserveMemory = resources.getMinMemory();
            if (reserveMemory > freeMemory) {
                throw new Error(`Could not reserve memory ${reserveMemory}, since only ${freeMemory} free.`);
            }
            if (resources.maxMemory > 0) {
                reserveMemory = Math.min(freeMemory, resources.maxMemory);
            } else {
                reserveMemory = freeMemory;
            }
            memory = reserveMemory;
        }

        const freeGpu = this.getGpuCount() - this.getReservedGpuCount();
        if (resources.gpu) {
            if (resources.gpu > freeGpu) {
                throw new Error(`Could not reserve gpu ${resources.gpu}, since only ${freeGpu} free.`);
            }
            gpu = resources.gpu;
        } else {
            let reserveGpu = resources.getMinGpu();
            if (reserveGpu > 0) {
                if (reserveGpu > freeGpu) {
                    throw new Error(`Could not reserve gpu ${reserveGpu}, since only ${freeGpu} free.`);
                }
                if (resources.maxGpu > 0) {
                    reserveGpu = Math.min(freeGpu, resources.maxGpu);
                } else {
                    reserveGpu = freeGpu;
                }
            }
            gpu = reserveGpu;
        }


        this.cpu.reserved += cpu;
        this.memory.reserved += memory;

        const result = new JobAssignedResources;
        result.cpu = cpu;
        result.memory = memory;

        let needGpus = gpu;

        for (const ourGpu of this.gpu) {
            if (needGpus <= 0) break;

            if (!ourGpu.reserved && ourGpu.memory >= resources.minGpuMemory) {
                needGpus--;
                ourGpu.reserved = true;
                result.gpus.push(new JobAssignedResourcesGpu(
                    ourGpu.uuid,
                    ourGpu.name,
                    ourGpu.memory,
                ));
            }
        }

        return result;
    }

    public getGpu(uuid: string): NodeGpuResource | undefined {
        for (const gpu of this.gpu) {
            if (gpu.uuid === uuid) {
                return gpu;
            }
        }
    }

    public hasCpu(minimum: number) {
        return this.cpu.total >= minimum;
    }

    public hasFreeCpu(minimum: number) {
        return this.cpu.total > 0 && this.cpu.total - this.cpu.reserved >= minimum;
    }

    public hasMemory(minimum: number) {
        return this.memory.total >= minimum;
    }

    public hasFreeMemory(minimum: number) {
        return this.memory.total > 0 && this.memory.total - this.memory.reserved >= minimum;
    }

    public hasGpu(minimum: number) {
        return this.gpu.length >= minimum;
    }

    public hasFreeGpu(minimum: number) {
        return this.gpu.filter(v => {
            return !v.reserved;
        }).length >= minimum;
    }

    public getGpuCount(): number {
        return this.gpu.length;
    }

    public getReservedGpuCount(): number {
        return this.gpu.filter(v => v.reserved).length;
    }

    public hasGpuMemory(minimum: number, memory: number) {
        return this.gpu.filter(v => {
            return v.memory >= memory;
        }).length >= minimum;
    }

    public hasFreeGpuMemory(minimum: number, memory: number) {
        return this.gpu.filter(v => {
            return !v.reserved && v.memory >= memory;
        }).length >= minimum;
    }
}

export class NodeCpuResource {
    constructor(
        @f.asName('usage') public usage: number,
    ) {
    }
}

export type NodeHardwarePlatform = 'aix' | 'darwin' | 'freebsd' | 'linux' | 'openbsd' | 'sunos' | 'win32';

export class NodeHardwareInformationCpu {
    constructor(
        /**
         * In MegaHerz.
         */
        @f.asName('speed') public speed: number,
        @f.asName('cpuName') public cpuName: string,
    ) {
    }
}

/**
 * This struct contains max/limits.
 */
export class NodeHardwareInformationGpu {
    @f
    brand: string = '';

    @f
    powerLimit: number = 0;

    @f
    temperatureMax: number = 0;

    constructor(
        @f.asName('uuid') public uuid: string,
        @f.asName('name') public name: string,
        /**
         * Value in MHz.
         */
        @f.asName('clock') public clock: number,
        /**
         * Value in GB.
         */
        @f.asName('memory') public memory: number,
    ) {
    }
}

export class NodeHardwareInformationDrive {
    constructor(
        @f.asName('name') public name: string,
        /**
         * e.g. /dev/disk0
         */
        @f.asName('device') public device: string,
        /**
         * In Gigabytes.
         */
        @f.asName('size') public size: number,
        @f.any().asArray().asName('mountpoints') public mountpoints: { path: string, label: string | null }[],
    ) {
    }
}

@Entity('nodeHardwareInformation')
export class NodeHardwareInformation {
    @f
    platform: NodeHardwarePlatform = 'linux';

    @f
    deviceDescription: string = '';

    @f
    osDescription: string = '';

    @f
    cpuDescription: string = '';

    @f.array(String)
    gpuDescriptions: string[] = [];

    /**
     * In Gigabytes.
     */
    @f
    memoryTotal: number = 0;

    /**
     * In Gigabytes.
     */
    @f.array(NodeHardwareInformationDrive)
    drives: NodeHardwareInformationDrive[] = [];

    @f.array(NodeHardwareInformationCpu)
    cpus: NodeHardwareInformationCpu[] = [];

    @f.array(NodeHardwareInformationGpu)
    gpus: NodeHardwareInformationGpu[] = [];

    public getCpuMinSpeed(): number {
        if (!this.cpus.length) return 0;

        return Math.min(...this.cpus.map(v => v.speed));
    }

    public getCpuMaxSpeed(): number {
        if (!this.cpus.length) return 0;
        return Math.min(...this.cpus.map(v => v.speed));
    }

    public getGpuMemoryMin(): number {
        if (!this.gpus.length) return 0;
        return Math.min(...this.gpus.map(v => v.memory)) || 0;
    }

    public getGpuMemoryMax(): number {
        if (!this.gpus.length) return 0;
        return Math.min(...this.gpus.map(v => v.memory)) || 0;
    }

    public getTotalDriveSize(): number {
        return this.drives.reduce((p, v) => p = v.size, 0);
    }
}

export class NodeHardwareStatsGpu {
    /**
     * Value in MHz.
     */
    @f
    clock: number = 0;

    /**
     * Value 0->1.
     */
    @f
    gpuUtilization: number = 0;

    /**
     * Value 0->1.
     */
    @f
    memory: number = 0;

    /**
     * Value in Celsius.
     */
    @f
    temperature: number = 0;

    /**
     * Value in Watt.
     */
    @f
    powerDraw: number = 0;

    constructor(
        @f.asName('uuid') public uuid: string,
    ) {
    }
}

/**
 * Usage stats.
 */
@Entity('nodeHardwareStats')
export class NodeHardwareStats {
    @f
    uptime: number = 0;

    /**
     * In Gigabytes.
     */
    @f
    memoryUsage: number = 0;

    /**
     * In Gigabytes.
     */
    @f.array(Number)
    driveUsage: number[] = [];

    @f.array(NodeCpuResource)
    cpus: NodeCpuResource[] = [];

    @f.array(NodeHardwareStatsGpu)
    gpus: NodeHardwareStatsGpu[] = [];

    public getGpu(uuid: string): NodeHardwareStatsGpu | undefined {
        for (const gpu of this.gpus) {
            if (gpu.uuid === uuid) {
                return gpu;
            }
        }
    }

    public getCPUCoreCount(): number {
        return this.cpus.length;
    }

    public getTotalCPUUsage(): number {
        return this.cpus.reduce((p, v) => p + v.usage, 0);
    }

    public getGPUCoreCount(): number {
        return this.gpus.length;
    }

    public getTotalGpuUsage(): number {
        return this.gpus.reduce((p, v) => p + v.gpuUtilization, 0);
    }

    public getTotalGpuMemoryUsage(): number {
        return this.gpus.reduce((p, v) => p + v.memory, 0);
    }
}

export class NodeDockerInformation {
    @f.array(String)
    container: string[] = [];

    @f.array(String)
    images: string[] = [];
}

export enum ClusterNodeStatus {
    offline = 0,
    booting = 200,
    connecting = 300,
    provisioning = 400,
    starting = 500,
    started = 600,
    ended = 700,
    error = 800,
}

export enum ClusterNodeType {
    dedicated = 0,
    google_cloud = 100,
    aws = 200,
}

export class ClusterNodeDockerMount {
    constructor(
        @f.asName('source') public source: string,
        @f.asName('target') public target: string,
    ) {
    }
}

@Entity('ClusterNodeJobStartConfig')
export class ClusterNodeJobStartConfig {
    @f.array(String)
    env: string[] = []; //e.g. ["PATH=bla"]

    @f.array(String)
    dockerBinds: string[] = []; //e.g. ["/tmp:/tmp"]

    @f hostExecutionAllowed: boolean = false;

    @f customMountsAllowed: boolean = false;
}

@Entity('node', 'nodes')
export class ClusterNode implements IdInterface {
    @f.uuid().primary()
    id: string = uuid();

    @f
    version: number = 1;

    @f.enum(ClusterNodeType)
    type: ClusterNodeType = ClusterNodeType.dedicated;

    @f.enum(ClusterNodeStatus)
    status: ClusterNodeStatus = ClusterNodeStatus.offline;

    /**
     * The instance id for cloud nodes
     */
    @f
    instanceId: string = '';

    @f
    tunnelActive: boolean = false;

    @f
    tunnelError: string = '';

    @f.optional().index() lastConnectionTry?: Date;

    @f.type(ClusterNodeJobStartConfig)
    jobStartConfig: ClusterNodeJobStartConfig = new ClusterNodeJobStartConfig;

    /**
     * Whether the machine is disabled and thus we don't automatically connect to it.
     */
    @f.index()
    disabled: boolean = false;

    @f.uuid().optional().index()
    owner!: string;

    @f.uuid()
    token: string = uuid();

    @f
    priority: number = 1;

    @f.any().optional()
    nvidiaInfo: { driverVersion: string, cudaVersion: string } | undefined;

    @f.any()
    dockerInfo: any = {};

    @f.index()
    connected: boolean = false;

    @f.optional()
    connectedTime?: Date;

    @f
    ready: boolean = false;

    @f.optional()
    ping?: Date;

    @f
    information: NodeHardwareInformation = new NodeHardwareInformation;

    @f
    stats: NodeHardwareStats = new NodeHardwareStats;

    @f
    resources: NodeResources = new NodeResources;

    // @f
    // master: boolean = false;

    /**
     * Values seconds.
     */
    @f.any().asMap()
    peerConnections: { [peerNodeId: string]: { ping: number } } = {};

    @f
    speedPort: number = 61720;

    @f
    localIp: string = '';

    @f
    publicIp: string = '';

    @f
    created: Date = new Date();

    @f
    updated: Date = new Date();

    @f
    host: string = '';

    @f
    sudoFailed: boolean = false;

    @f
    machineError: string = '';

    constructor(
        @f.asName('name') public name: string,
        @f.uuid().asName('cluster') public cluster: string,
    ) {
    }

    public isDockerReady(): boolean {
        return this.dockerInfo && this.dockerInfo.ServerVersion;
    }

    /**
     * For dedicated this returns always true, which indicates that the machine actually exists
     * For cloud server this is true when the machine is created and (automatically) booting.
     */
    isCreated(): boolean {
        if (this.isCloud()) {
            return !!this.instanceId;
        }

        return true;
    }

    isCloud(): boolean {
        return this.type === ClusterNodeType.google_cloud || this.type === ClusterNodeType.aws;
    }

    getJobStartConfig(): ClusterNodeJobStartConfig {
        return cloneClass(this.jobStartConfig);
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public getStatusLabel(): string {
        return ClusterNodeStatus[this.status];
    }

    public getMemoryUsageInPercent(): number {
        return Math.min(1, this.stats.memoryUsage / this.information.memoryTotal);
    }

    public getCpuUsageInPercent(): number {
        return Math.min(1, this.stats.getTotalCPUUsage() / this.stats.getCPUCoreCount());
    }

    public getGpuUsageInPercent(): number {
        return Math.min(1, this.stats.getTotalGpuUsage() / this.stats.getGPUCoreCount());
    }

    public getGpuMemoryUsageInPercent(): number {
        return Math.min(1, this.stats.getTotalGpuMemoryUsage() / this.stats.getGPUCoreCount());
    }
}

@Entity('clusterNodeCredentials')
export class ClusterNodeCredentials {
    @f
    sshPort: number = 22;

    @f
    sshUsername: string = '';

    @f
    sshPassword: string = '';

    @f
    sshPrivateKey: string = '';

    @f
    sshPrivateKeyPassphrase: string = '';

    @f
    sshRequiresSudo: boolean = false;

    @f.uuid()
    token: string = uuid();

    constructor(
        @f.uuid().asName('nodeId').primary()
        public nodeId: string
    ) {
    }
}
