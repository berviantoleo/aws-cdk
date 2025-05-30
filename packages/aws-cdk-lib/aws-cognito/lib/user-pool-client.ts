import { Construct } from 'constructs';
import { CfnUserPoolClient } from './cognito.generated';
import { IUserPool } from './user-pool';
import { ClientAttributes } from './user-pool-attr';
import { IUserPoolResourceServer, ResourceServerScope } from './user-pool-resource-server';
import { IRole } from '../../aws-iam';
import { CfnApp } from '../../aws-pinpoint';
import { IResource, Resource, Duration, Stack, SecretValue, Token, FeatureFlags } from '../../core';
import { ValidationError } from '../../core/lib/errors';
import { addConstructMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';
import { AwsCustomResource, AwsCustomResourcePolicy, Logging, PhysicalResourceId } from '../../custom-resources';
import * as cxapi from '../../cx-api';

/**
 * Types of authentication flow
 * @see https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow.html
 */
export interface AuthFlow {
  /**
   * Enable admin based user password authentication flow
   * @default false
   */
  readonly adminUserPassword?: boolean;

  /**
   * Enable custom authentication flow
   * @default false
   */
  readonly custom?: boolean;

  /**
   * Enable auth using username & password
   * @default false
   */
  readonly userPassword?: boolean;

  /**
   * Enable SRP based authentication
   * @default false
   */
  readonly userSrp?: boolean;

  /**
   * Enable Choice-based authentication
   * @default false
   */
  readonly user?: boolean;
}

/**
 * OAuth settings to configure the interaction between the app and this client.
 */
export interface OAuthSettings {

  /**
   * OAuth flows that are allowed with this client.
   * @see - the 'Allowed OAuth Flows' section at https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-app-idp-settings.html
   * @default {authorizationCodeGrant:true,implicitCodeGrant:true}
   */
  readonly flows?: OAuthFlows;

  /**
   * List of allowed redirect URLs for the identity providers.
   * @default - ['https://example.com'] if either authorizationCodeGrant or implicitCodeGrant flows are enabled, no callback URLs otherwise.
   */
  readonly callbackUrls?: string[];

  /**
   * List of allowed logout URLs for the identity providers.
   * @default - no logout URLs
   */
  readonly logoutUrls?: string[];

  /**
   * OAuth scopes that are allowed with this client.
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-app-idp-settings.html
   * @default [OAuthScope.PHONE,OAuthScope.EMAIL,OAuthScope.OPENID,OAuthScope.PROFILE,OAuthScope.COGNITO_ADMIN]
   */
  readonly scopes?: OAuthScope[];

  /**
   * The default redirect URI.
   * Must be in the `callbackUrls` list.
   *
   * A redirect URI must:
   * * Be an absolute URI
   * * Be registered with the authorization server.
   * * Not include a fragment component.
   *
   * @see https://tools.ietf.org/html/rfc6749#section-3.1.2
   *
   * Amazon Cognito requires HTTPS over HTTP except for http://localhost for testing purposes only.
   *
   * App callback URLs such as myapp://example are also supported.
   *
   * @default - no default redirect URI
   */
  readonly defaultRedirectUri?: string;
}

/**
 * Types of OAuth grant flows
 * @see - the 'Allowed OAuth Flows' section at https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-app-idp-settings.html
 */
export interface OAuthFlows {
  /**
   * Initiate an authorization code grant flow, which provides an authorization code as the response.
   * @default false
   */
  readonly authorizationCodeGrant?: boolean;

  /**
   * The client should get the access token and ID token directly.
   * @default false
   */
  readonly implicitCodeGrant?: boolean;

  /**
   * Client should get the access token and ID token from the token endpoint
   * using a combination of client and client_secret.
   * @default false
   */
  readonly clientCredentials?: boolean;
}

/**
 * OAuth scopes that are allowed with this client.
 * @see https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-app-idp-settings.html
 */
export class OAuthScope {
  /**
   * Grants access to the 'phone_number' and 'phone_number_verified' claims.
   * Automatically includes access to `OAuthScope.OPENID`.
   */
  public static readonly PHONE = new OAuthScope('phone');

  /**
   * Grants access to the 'email' and 'email_verified' claims.
   * Automatically includes access to `OAuthScope.OPENID`.
   */
  public static readonly EMAIL = new OAuthScope('email');

  /**
   * Returns all user attributes in the ID token that are readable by the client
   */
  public static readonly OPENID = new OAuthScope('openid');

  /**
   * Grants access to all user attributes that are readable by the client
   * Automatically includes access to `OAuthScope.OPENID`.
   */
  public static readonly PROFILE = new OAuthScope('profile');

  /**
   * Grants access to Amazon Cognito User Pool API operations that require access tokens,
   * such as UpdateUserAttributes and VerifyUserAttribute.
   */
  public static readonly COGNITO_ADMIN = new OAuthScope('aws.cognito.signin.user.admin');

  /**
   * Custom scope is one that you define for your own resource server in the Resource Servers.
   * The format is 'resource-server-identifier/scope'.
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html
   */
  public static custom(name: string) {
    return new OAuthScope(name);
  }

  /**
   * Adds a custom scope that's tied to a resource server in your stack
   */
  public static resourceServer(server: IUserPoolResourceServer, scope: ResourceServerScope) {
    return new OAuthScope(`${server.userPoolResourceServerId}/${scope.scopeName}`);
  }

  /**
   * The name of this scope as recognized by CloudFormation.
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpoolclient.html#cfn-cognito-userpoolclient-allowedoauthscopes
   */
  public readonly scopeName: string;

  private constructor(scopeName: string) {
    this.scopeName = scopeName;
  }
}

/**
 * Identity providers supported by the UserPoolClient
 */
export class UserPoolClientIdentityProvider {
  /**
   * Allow users to sign in using 'Sign In With Apple'.
   * A `UserPoolIdentityProviderApple` must be attached to the user pool.
   */
  public static readonly APPLE = new UserPoolClientIdentityProvider('SignInWithApple');

  /**
   * Allow users to sign in using 'Facebook Login'.
   * A `UserPoolIdentityProviderFacebook` must be attached to the user pool.
   */
  public static readonly FACEBOOK = new UserPoolClientIdentityProvider('Facebook');

  /**
   * Allow users to sign in using 'Google Login'.
   * A `UserPoolIdentityProviderGoogle` must be attached to the user pool.
   */
  public static readonly GOOGLE = new UserPoolClientIdentityProvider('Google');

  /**
   * Allow users to sign in using 'Login With Amazon'.
   * A `UserPoolIdentityProviderAmazon` must be attached to the user pool.
   */
  public static readonly AMAZON = new UserPoolClientIdentityProvider('LoginWithAmazon');

  /**
   * Allow users to sign in directly as a user of the User Pool
   */
  public static readonly COGNITO = new UserPoolClientIdentityProvider('COGNITO');

  /**
   * Specify a provider not yet supported by the CDK.
   * @param name name of the identity provider as recognized by CloudFormation property `SupportedIdentityProviders`
   */
  public static custom(name: string) {
    return new UserPoolClientIdentityProvider(name);
  }

  /** The name of the identity provider as recognized by CloudFormation property `SupportedIdentityProviders` */
  public readonly name: string;

  private constructor(name: string) {
    this.name = name;
  }
}

/**
 * Options to create a UserPoolClient
 */
export interface UserPoolClientOptions {
  /**
   * Name of the application client
   * @default - cloudformation generated name
   */
  readonly userPoolClientName?: string;

  /**
   * Whether to generate a client secret
   * @default false
   */
  readonly generateSecret?: boolean;

  /**
   * The set of OAuth authentication flows to enable on the client
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow.html
   * @default - If you don't specify a value, your user client supports ALLOW_REFRESH_TOKEN_AUTH, ALLOW_USER_SRP_AUTH, and ALLOW_CUSTOM_AUTH.
   */
  readonly authFlows?: AuthFlow;

  /**
   * Turns off all OAuth interactions for this client.
   * @default false
   */
  readonly disableOAuth?: boolean;

  /**
   * OAuth settings for this client to interact with the app.
   * An error is thrown when this is specified and `disableOAuth` is set.
   * @default - see defaults in `OAuthSettings`. meaningless if `disableOAuth` is set.
   */
  readonly oAuth?: OAuthSettings;

  /**
   * Cognito creates a session token for each API request in an authentication flow.
   * AuthSessionValidity is the duration, in minutes, of that session token.
   * see defaults in `AuthSessionValidity`. Valid duration is from 3 to 15 minutes.
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpoolclient.html#cfn-cognito-userpoolclient-authsessionvalidity
   * @default - Duration.minutes(3)
   */
  readonly authSessionValidity?: Duration;

  /**
   * Whether Cognito returns a UserNotFoundException exception when the
   * user does not exist in the user pool (false), or whether it returns
   * another type of error that doesn't reveal the user's absence.
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-managing-errors.html
   * @default false
   */
  readonly preventUserExistenceErrors?: boolean;

  /**
   * The list of identity providers that users should be able to use to sign in using this client.
   *
   * @default - supports all identity providers that are registered with the user pool. If the user pool and/or
   * identity providers are imported, either specify this option explicitly or ensure that the identity providers are
   * registered with the user pool using the `UserPool.registerIdentityProvider()` API.
   */
  readonly supportedIdentityProviders?: UserPoolClientIdentityProvider[];

  /**
   * Validity of the ID token.
   * Values between 5 minutes and 1 day are valid. The duration can not be longer than the refresh token validity.
   * @see https://docs.aws.amazon.com/en_us/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html#amazon-cognito-user-pools-using-the-id-token
   * @default Duration.minutes(60)
   */
  readonly idTokenValidity?: Duration;

  /**
   * Validity of the refresh token.
   * Values between 60 minutes and 10 years are valid.
   * @see https://docs.aws.amazon.com/en_us/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html#amazon-cognito-user-pools-using-the-refresh-token
   * @default Duration.days(30)
   */
  readonly refreshTokenValidity?: Duration;

  /**
   * Validity of the access token.
   * Values between 5 minutes and 1 day are valid. The duration can not be longer than the refresh token validity.
   * @see https://docs.aws.amazon.com/en_us/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html#amazon-cognito-user-pools-using-the-access-token
   * @default Duration.minutes(60)
   */
  readonly accessTokenValidity?: Duration;

  /**
   * The set of attributes this client will be able to read.
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-attribute-permissions-and-scopes
   * @default - all standard and custom attributes
   */
  readonly readAttributes?: ClientAttributes;

  /**
   * The set of attributes this client will be able to write.
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-attribute-permissions-and-scopes
   * @default - all standard and custom attributes
   */
  readonly writeAttributes?: ClientAttributes;

  /**
   * Enable token revocation for this client.
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html#enable-token-revocation
   * @default true for new user pool clients
   */
  readonly enableTokenRevocation?: boolean;

  /**
   * Enable the propagation of additional user context data.
   * You can only activate enablePropagateAdditionalUserContextData in an app client that has a client secret.
   * @see https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-adaptive-authentication.html#user-pool-settings-adaptive-authentication-device-fingerprint
   * @default false for new user pool clients
   */
  readonly enablePropagateAdditionalUserContextData?: boolean;

  /**
   * The analytics configuration for this client.
   * @default - no analytics configuration
   */
  readonly analytics?: AnalyticsConfiguration;
}

/**
 * Properties for the UserPoolClient construct
 */
export interface UserPoolClientProps extends UserPoolClientOptions {
  /**
   * The UserPool resource this client will have access to
   */
  readonly userPool: IUserPool;
}

/**
 * The settings for Amazon Pinpoint analytics configuration.
 * With an analytics configuration, your application can collect user-activity metrics for user notifications with an Amazon Pinpoint campaign.
 * Amazon Pinpoint isn't available in all AWS Regions.
 * For a list of available Regions, see Amazon Cognito and Amazon Pinpoint Region availability: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-pinpoint-integration.html#cognito-user-pools-find-region-mappings.
 */
export interface AnalyticsConfiguration {
  /**
   * The Amazon Pinpoint project that you want to connect to your user pool app client.
   * Amazon Cognito publishes events to the Amazon Pinpoint project.
   * You can also configure your application to pass an endpoint ID in the `AnalyticsMetadata` parameter of sign-in operations.
   * The endpoint ID is information about the destination for push notifications.
   * @default - no configuration, you need to specify either `application` or all of `applicationId`, `externalId`, and `role`.
   */
  readonly application?: CfnApp;

  /**
   * Your Amazon Pinpoint project ID.
   * @default - no configuration, you need to specify either this property along with `externalId` and `role` or `application`.
   */
  readonly applicationId?: string;

  /**
   * The external ID of the role that Amazon Cognito assumes to send analytics data to Amazon Pinpoint. More info here: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html
   * @default - no configuration, you need to specify either this property along with `applicationId` and `role` or `application`.
   */
  readonly externalId?: string;

  /**
   * The IAM role that has the permissions required for Amazon Cognito to publish events to Amazon Pinpoint analytics.
   * @default - no configuration, you need to specify either this property along with `applicationId` and `externalId` or `application`.
   */
  readonly role?: IRole;

  /**
   * If `true`, Amazon Cognito includes user data in the events that it publishes to Amazon Pinpoint analytics.
   * @default - false
   */
  readonly shareUserData?: boolean;
}

/**
 * Represents a Cognito user pool client.
 */
export interface IUserPoolClient extends IResource {
  /**
   * Name of the application client
   * @attribute
   */
  readonly userPoolClientId: string;

  /**
   * The generated client secret. Only available if the "generateSecret" props is set to true
   * @attribute
   */
  readonly userPoolClientSecret: SecretValue;
}

/**
 * Define a UserPool App Client
 */
@propertyInjectable
export class UserPoolClient extends Resource implements IUserPoolClient {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-cognito.UserPoolClient';

  /**
   * Import a user pool client given its id.
   */
  public static fromUserPoolClientId(scope: Construct, id: string, userPoolClientId: string): IUserPoolClient {
    class Import extends Resource implements IUserPoolClient {
      public readonly userPoolClientId = userPoolClientId;
      get userPoolClientSecret(): SecretValue {
        throw new ValidationError('UserPool Client Secret is not available for imported Clients', this);
      }
    }

    return new Import(scope, id);
  }

  public readonly userPoolClientId: string;

  private _generateSecret?: boolean;
  private readonly userPool: IUserPool;
  private _userPoolClientSecret?: SecretValue;

  /**
   * The OAuth flows enabled for this client.
   */
  public readonly oAuthFlows: OAuthFlows;
  private readonly _userPoolClientName?: string;

  /*
   * Note to implementers: Two CloudFormation return values Name and ClientSecret are part of the spec.
   * However, they have been explicity not implemented here. They are not documented in CloudFormation, and
   * CloudFormation returns the following the string when these two attributes are 'GetAtt' - "attribute not supported
   * at this time, please use the CLI or Console to retrieve this value".
   * Awaiting updates from CloudFormation.
   */

  constructor(scope: Construct, id: string, props: UserPoolClientProps) {
    super(scope, id);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if (props.disableOAuth && props.oAuth) {
      throw new ValidationError('OAuth settings cannot be specified when disableOAuth is set.', this);
    }

    this.oAuthFlows = props.oAuth?.flows ?? {
      implicitCodeGrant: true,
      authorizationCodeGrant: true,
    };

    let callbackUrls: string[] | undefined = props.oAuth?.callbackUrls;
    if (this.oAuthFlows.authorizationCodeGrant || this.oAuthFlows.implicitCodeGrant) {
      if (callbackUrls === undefined) {
        callbackUrls = ['https://example.com'];
      } else if (callbackUrls.length === 0) {
        throw new ValidationError('callbackUrl must not be empty when codeGrant or implicitGrant OAuth flows are enabled.', this);
      }
    }

    if (props.oAuth?.defaultRedirectUri && !Token.isUnresolved(props.oAuth.defaultRedirectUri)) {
      if (callbackUrls && !callbackUrls.includes(props.oAuth.defaultRedirectUri)) {
        throw new ValidationError('defaultRedirectUri must be included in callbackUrls.', this);
      }

      const defaultRedirectUriPattern = /^(?=.{1,1024}$)[\p{L}\p{M}\p{S}\p{N}\p{P}]+$/u;
      if (!defaultRedirectUriPattern.test(props.oAuth.defaultRedirectUri)) {
        throw new ValidationError(`defaultRedirectUri must match the \`^(?=.{1,1024}$)[\p{L}\p{M}\p{S}\p{N}\p{P}]+$\` pattern, got ${props.oAuth.defaultRedirectUri}`, this);
      }
    }

    if (!props.generateSecret && props.enablePropagateAdditionalUserContextData) {
      throw new ValidationError('Cannot activate enablePropagateAdditionalUserContextData in an app client without a client secret.', this);
    }

    this._generateSecret = props.generateSecret;
    this.userPool = props.userPool;

    const resource = new CfnUserPoolClient(this, 'Resource', {
      clientName: props.userPoolClientName,
      generateSecret: props.generateSecret,
      userPoolId: props.userPool.userPoolId,
      explicitAuthFlows: this.configureAuthFlows(props),
      allowedOAuthFlows: props.disableOAuth ? undefined : this.configureOAuthFlows(),
      allowedOAuthScopes: props.disableOAuth ? undefined : this.configureOAuthScopes(props.oAuth),
      defaultRedirectUri: props.oAuth?.defaultRedirectUri,
      callbackUrLs: callbackUrls && callbackUrls.length > 0 && !props.disableOAuth ? callbackUrls : undefined,
      logoutUrLs: props.oAuth?.logoutUrls,
      allowedOAuthFlowsUserPoolClient: !props.disableOAuth,
      preventUserExistenceErrors: this.configurePreventUserExistenceErrors(props.preventUserExistenceErrors),
      supportedIdentityProviders: this.configureIdentityProviders(props),
      readAttributes: props.readAttributes?.attributes(),
      writeAttributes: props.writeAttributes?.attributes(),
      enableTokenRevocation: props.enableTokenRevocation,
      enablePropagateAdditionalUserContextData: props.enablePropagateAdditionalUserContextData,
      analyticsConfiguration: props.analytics ? this.configureAnalytics(props.analytics) : undefined,
    });
    this.configureAuthSessionValidity(resource, props);
    this.configureTokenValidity(resource, props);

    this.userPoolClientId = resource.ref;
    this._userPoolClientName = props.userPoolClientName;
  }

  /**
   * The client name that was specified via the `userPoolClientName` property during initialization,
   * throws an error otherwise.
   */
  public get userPoolClientName(): string {
    if (this._userPoolClientName === undefined) {
      throw new ValidationError('userPoolClientName is available only if specified on the UserPoolClient during initialization', this);
    }
    return this._userPoolClientName;
  }

  public get userPoolClientSecret(): SecretValue {
    if (!this._generateSecret) {
      throw new ValidationError('userPoolClientSecret is available only if generateSecret is set to true.', this);
    }

    const isEnableLogUserPoolClientSecret = FeatureFlags.of(this).isEnabled(cxapi.LOG_USER_POOL_CLIENT_SECRET_VALUE);

    // Create the Custom Resource that assists in resolving the User Pool Client secret
    // just once, no matter how many times this method is called
    if (!this._userPoolClientSecret) {
      this._userPoolClientSecret = SecretValue.resourceAttribute(new AwsCustomResource(
        this,
        'DescribeCognitoUserPoolClient',
        {
          resourceType: 'Custom::DescribeCognitoUserPoolClient',
          onUpdate: {
            region: Stack.of(this).region,
            service: 'CognitoIdentityServiceProvider',
            action: 'describeUserPoolClient',
            parameters: {
              UserPoolId: this.userPool.userPoolId,
              ClientId: this.userPoolClientId,
            },
            physicalResourceId: PhysicalResourceId.of(this.userPoolClientId),
            logging: isEnableLogUserPoolClientSecret ? undefined : Logging.withDataHidden(),
          },
          policy: AwsCustomResourcePolicy.fromSdkCalls({
            resources: [this.userPool.userPoolArn],
          }),
          // APIs are available in 2.1055.0
          installLatestAwsSdk: false,
        },
      ).getResponseField('UserPoolClient.ClientSecret'));
    }

    return this._userPoolClientSecret;
  }

  private configureAuthFlows(props: UserPoolClientProps): string[] | undefined {
    if (!props.authFlows || Object.keys(props.authFlows).length === 0) return undefined;

    const authFlows: string[] = [];
    if (props.authFlows.userPassword) { authFlows.push('ALLOW_USER_PASSWORD_AUTH'); }
    if (props.authFlows.adminUserPassword) { authFlows.push('ALLOW_ADMIN_USER_PASSWORD_AUTH'); }
    if (props.authFlows.custom) { authFlows.push('ALLOW_CUSTOM_AUTH'); }
    if (props.authFlows.userSrp) { authFlows.push('ALLOW_USER_SRP_AUTH'); }
    if (props.authFlows.user) { authFlows.push('ALLOW_USER_AUTH'); }

    // refreshToken should always be allowed if authFlows are present
    authFlows.push('ALLOW_REFRESH_TOKEN_AUTH');

    return authFlows;
  }

  private configureOAuthFlows(): string[] | undefined {
    if ((this.oAuthFlows.authorizationCodeGrant || this.oAuthFlows.implicitCodeGrant) && this.oAuthFlows.clientCredentials) {
      throw new ValidationError('clientCredentials OAuth flow cannot be selected along with codeGrant or implicitGrant.', this);
    }
    const oAuthFlows: string[] = [];
    if (this.oAuthFlows.clientCredentials) { oAuthFlows.push('client_credentials'); }
    if (this.oAuthFlows.implicitCodeGrant) { oAuthFlows.push('implicit'); }
    if (this.oAuthFlows.authorizationCodeGrant) { oAuthFlows.push('code'); }

    if (oAuthFlows.length === 0) {
      return undefined;
    }
    return oAuthFlows;
  }

  private configureOAuthScopes(oAuth?: OAuthSettings): string[] {
    const scopes = oAuth?.scopes ?? [OAuthScope.PROFILE, OAuthScope.PHONE, OAuthScope.EMAIL, OAuthScope.OPENID,
      OAuthScope.COGNITO_ADMIN];
    const scopeNames = new Set(scopes.map((x) => x.scopeName));
    const autoOpenIdScopes = [OAuthScope.PHONE, OAuthScope.EMAIL, OAuthScope.PROFILE];
    if (autoOpenIdScopes.reduce((agg, s) => agg || scopeNames.has(s.scopeName), false)) {
      scopeNames.add(OAuthScope.OPENID.scopeName);
    }
    return Array.from(scopeNames);
  }

  private configurePreventUserExistenceErrors(prevent?: boolean): string | undefined {
    if (prevent === undefined) {
      return undefined;
    }
    return prevent ? 'ENABLED' : 'LEGACY';
  }

  private configureIdentityProviders(props: UserPoolClientProps): string[] | undefined {
    let providers: string[];
    if (!props.supportedIdentityProviders) {
      const providerSet = new Set(props.userPool.identityProviders.map((p) => p.providerName));
      providerSet.add('COGNITO');
      providers = Array.from(providerSet);
    } else {
      providers = props.supportedIdentityProviders.map((p) => p.name);
    }
    if (providers.length === 0) { return undefined; }
    return Array.from(providers);
  }

  private configureAuthSessionValidity(resource: CfnUserPoolClient, props: UserPoolClientProps) {
    this.validateDuration('authSessionValidity', Duration.minutes(3), Duration.minutes(15), props.authSessionValidity);
    resource.authSessionValidity = props.authSessionValidity ? props.authSessionValidity.toMinutes() : undefined;
  }

  private configureTokenValidity(resource: CfnUserPoolClient, props: UserPoolClientProps) {
    this.validateDuration('idTokenValidity', Duration.minutes(5), Duration.days(1), props.idTokenValidity);
    this.validateDuration('accessTokenValidity', Duration.minutes(5), Duration.days(1), props.accessTokenValidity);
    this.validateDuration('refreshTokenValidity', Duration.minutes(60), Duration.days(10 * 365), props.refreshTokenValidity);
    if (props.refreshTokenValidity) {
      this.validateDuration('idTokenValidity', Duration.minutes(5), props.refreshTokenValidity, props.idTokenValidity);
      this.validateDuration('accessTokenValidity', Duration.minutes(5), props.refreshTokenValidity, props.accessTokenValidity);
    }

    if (props.accessTokenValidity || props.idTokenValidity || props.refreshTokenValidity) {
      resource.tokenValidityUnits = {
        idToken: props.idTokenValidity ? 'minutes' : undefined,
        accessToken: props.accessTokenValidity ? 'minutes' : undefined,
        refreshToken: props.refreshTokenValidity ? 'minutes' : undefined,
      };
    }

    resource.idTokenValidity = props.idTokenValidity ? props.idTokenValidity.toMinutes() : undefined;
    resource.refreshTokenValidity = props.refreshTokenValidity ? props.refreshTokenValidity.toMinutes() : undefined;
    resource.accessTokenValidity = props.accessTokenValidity ? props.accessTokenValidity.toMinutes() : undefined;
  }

  private validateDuration(name: string, min: Duration, max: Duration, value?: Duration) {
    if (value === undefined) { return; }
    if (value.toMilliseconds() < min.toMilliseconds() || value.toMilliseconds() > max.toMilliseconds()) {
      throw new ValidationError(`${name}: Must be a duration between ${min.toHumanString()} and ${max.toHumanString()} (inclusive); received ${value.toHumanString()}.`, this);
    }
  }

  private configureAnalytics(analytics: AnalyticsConfiguration): CfnUserPoolClient.AnalyticsConfigurationProperty {
    // NOTE: CloudFormation expects either `ApplicationArn` or all of `ApplicationId`, `ExternalId`, and `RoleArn` to be provided.
    if (
      analytics.application &&
        (analytics.applicationId || analytics.externalId || analytics.role)
    ) {
      throw new ValidationError('Either `application` or all of `applicationId`, `externalId` and `role` must be specified.', this);
    }

    if (
      !analytics.application &&
        (!analytics.applicationId || !analytics.externalId || !analytics.role)
    ) {
      throw new ValidationError('Either all of `applicationId`, `externalId` and `role` must be specified or `application` must be specified.', this);
    }

    return {
      applicationArn: analytics.application?.attrArn,
      applicationId: analytics.applicationId,
      externalId: analytics.externalId,
      roleArn: analytics.role?.roleArn,
      userDataShared: analytics.shareUserData,
    };
  }
}
