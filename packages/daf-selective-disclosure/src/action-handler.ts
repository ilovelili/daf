import { IAgentContext, IIdentityManager, IKeyManager, IAgentPlugin } from 'daf-core'
import { IDataStoreORM, TClaimsColumns, FindArgs } from 'daf-typeorm'
import {
  ICredentialsForSdr,
  IPresentationValidationResult,
  ISelectiveDisclosure,
  ICreateSelectiveDisclosureRequestArgs,
  IGetVerifiableCredentialsForSdrArgs,
  IValidatePresentationAgainstSdrArgs,
} from './types'
import { createJWT } from 'did-jwt'
import Debug from 'debug'

/**
 * This class adds support for creating
 * {@link https://github.com/uport-project/specs/blob/develop/flows/selectivedisclosure.md | Selective Disclosure} requests
 * and interpret the responses received.
 *
 * This implementation of the uPort protocol uses
 * {@link https://www.w3.org/TR/vc-data-model/#presentations | W3C Presentation}
 * as the response encoding instead of a `shareReq`.
 *
 * @beta
 */
export class SelectiveDisclosure implements IAgentPlugin {
  readonly methods: ISelectiveDisclosure

  constructor() {
    this.methods = {
      createSelectiveDisclosureRequest: this.createSelectiveDisclosureRequest,
      getVerifiableCredentialsForSdr: this.getVerifiableCredentialsForSdr,
      validatePresentationAgainstSdr: this.validatePresentationAgainstSdr,
    }
  }

  /**
   * Creates a Selective disclosure request, encoded as a JWT.
   *
   * @remarks See {@link https://github.com/uport-project/specs/blob/develop/flows/selectivedisclosure.md | Selective Disclosure}
   *
   * @param args - The param object with the properties necessary to create the request. See {@link ISelectiveDisclosureRequest}
   * @param context - *RESERVED* This is filled by the framework when the method is called.
   *
   * @beta
   */
  async createSelectiveDisclosureRequest(
    args: ICreateSelectiveDisclosureRequestArgs,
    context: IAgentContext<IIdentityManager & IKeyManager>,
  ): Promise<string> {
    const { data } = args
    try {
      const identity = await context.agent.identityManagerGetIdentity({ did: data.issuer })
      delete data.issuer
      Debug('daf:selective-disclosure:create-sdr')('Signing SDR with', identity.did)

      const key = identity.keys.find((k) => k.type === 'Secp256k1')
      if (!key) throw Error('Signing key not found')
      const signer = (data: string) => context.agent.keyManagerSignJWT({ kid: key.kid, data })
      const jwt = await createJWT(
        {
          type: 'sdr',
          ...data,
        },
        {
          signer,
          alg: 'ES256K-R',
          issuer: identity.did,
        },
      )
      return jwt
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Gathers the required credentials necessary to fulfill a Selective Disclosure Request.
   * It uses the {@link daf-typeorm#IDataStoreORM} plugin to query the local database for
   * the required credentials.
   *
   * @param args - Contains the Request to be fulfilled and the DID of the subject
   * @param context - *RESERVED* This is filled by the framework when the method is called.
   *
   * @beta
   */
  async getVerifiableCredentialsForSdr(
    args: IGetVerifiableCredentialsForSdrArgs,
    context: IAgentContext<IDataStoreORM>,
  ): Promise<ICredentialsForSdr[]> {
    const result: ICredentialsForSdr[] = []
    const findArgs: FindArgs<TClaimsColumns> = { where: [] }
    for (const credentialRequest of args.sdr.claims) {
      if (credentialRequest.claimType) {
        findArgs.where?.push({ column: 'type', value: [credentialRequest.claimType] })
      }

      if (credentialRequest.claimValue) {
        findArgs.where?.push({ column: 'value', value: [credentialRequest.claimValue] })
      }

      if (credentialRequest.issuers) {
        findArgs.where?.push({ column: 'issuer', value: credentialRequest.issuers.map((i) => i.did) })
      }

      if (credentialRequest.credentialType) {
        findArgs.where?.push({
          column: 'credentialType',
          value: ['%' + credentialRequest.credentialType + '%'],
          op: 'Like',
        })
      }

      if (credentialRequest.credentialContext) {
        findArgs.where?.push({
          column: 'context',
          value: ['%' + credentialRequest.credentialContext + '%'],
          op: 'Like',
        })
      }

      if (args.did || args.sdr.subject) {
        findArgs.where?.push({ column: 'subject', value: ['' + (args.did || args.sdr.subject)] })
      }

      const credentials = await context.agent.dataStoreORMGetVerifiableCredentialsByClaims(findArgs)

      result.push({
        ...credentialRequest,
        credentials,
      })
    }
    return result
  }

  /**
   * Validates a
   * {@link https://github.com/uport-project/specs/blob/develop/flows/selectivedisclosure.md | Selective Disclosure response}
   * encoded as a `Presentation`
   *
   * @param args - Contains the request and the response `Presentation` that needs to be checked.
   * @param context - *RESERVED* This is filled by the framework when the method is called.
   *
   * @beta
   */
  async validatePresentationAgainstSdr(
    args: IValidatePresentationAgainstSdrArgs,
    context: IAgentContext<{}>,
  ): Promise<IPresentationValidationResult> {
    let valid = true
    let claims = []
    for (const credentialRequest of args.sdr.claims) {
      let credentials = args.presentation.verifiableCredential.filter((credential) => {
        if (
          credentialRequest.claimType &&
          credentialRequest.claimValue &&
          credential.credentialSubject[credentialRequest.claimType] !== credentialRequest.claimValue
        ) {
          return false
        }

        if (
          credentialRequest.claimType &&
          !credentialRequest.claimValue &&
          credential.credentialSubject[credentialRequest.claimType] === undefined
        ) {
          return false
        }

        if (
          credentialRequest.issuers &&
          !credentialRequest.issuers.map((i) => i.did).includes(credential.issuer.id)
        ) {
          return false
        }
        if (
          credentialRequest.credentialContext &&
          !credential['@context'].includes(credentialRequest.credentialContext)
        ) {
          return false
        }

        if (credentialRequest.credentialType && !credential.type.includes(credentialRequest.credentialType)) {
          return false
        }

        return true
      })

      if (credentialRequest.essential === true && credentials.length == 0) {
        valid = false
      }

      claims.push({
        ...credentialRequest,
        credentials,
      })
    }
    return { valid, claims }
  }
}
