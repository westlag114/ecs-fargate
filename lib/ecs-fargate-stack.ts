import {
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as log,
  aws_route53 as route53,
  aws_route53_targets as route53Targets,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";

// todo:
// example.com は置き換えること
const domainName = `example.com`;

// VPC構築を構築しALBをパブリックサブネットに配置
// ECS Fargate を構築しALBからのリクエストを受け付ける
// ACMを作成しALBで利用
// Route53の設定でALBに対してAレコードを設定

export class CdkEcsFargateStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.1.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "PublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "PrivateIsolatedSubnet",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    // SecurityGroup
    const securityGroupELB = new ec2.SecurityGroup(this, "SecurityGroupELB", {
      vpc,
    });
    securityGroupELB.addIngressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.tcp(443)
    );

    const securityGroupApp = new ec2.SecurityGroup(this, "SecurityGroupApp", {
      vpc,
    });

    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: domainName,
    });

    const cert = new acm.DnsValidatedCertificate(this, "Certificate", {
      domainName: domainName,
      hostedZone,
      // region: "us-east-1",
      region: "ap-northeast-1", // ALBと同じリージョンに配置
    });

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      securityGroup: securityGroupELB,
      internetFacing: true,
    });
    const listenerHTTP = alb.addListener("ListenerHTTP", {
      port: 443,
      certificates: [
        {
          certificateArn: cert.certificateArn,
        },
      ],
    });
    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/",
        healthyHttpCodes: "200",
      },
    });

    listenerHTTP.addTargetGroups("DefaultHTTPSResponse", {
      targetGroups: [targetGroup],
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
    });

    // Fargate
    const fargateTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "TaskDef",
      {
        memoryLimitMiB: 1024,
        cpu: 512,
      }
    );
    const container = fargateTaskDefinition.addContainer("AppContainer", {
      image: ecs.ContainerImage.fromAsset("src/ecs/app"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "nest-app",
        logRetention: log.RetentionDays.ONE_MONTH,
      }),
    });
    container.addPortMappings({
      containerPort: 3000,
      hostPort: 3000,
    });
    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: fargateTaskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [securityGroupApp],
    });
    service.attachToApplicationTargetGroup(targetGroup);

    new route53.ARecord(this, `AliasRecord`, {
      zone: hostedZone,
      recordName: `ecs.${domainName}`,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(alb)
      ),
    });
  }
}
