import dayjs from 'dayjs'
import { findIndex, unionBy } from 'lodash'
import config from '@config'
import eventBus from '@/plugins/event-bus'
import TransactionModel from '@/models/transaction'
import Vue from 'vue'

const includes = (objects, find) => objects.map(a => a.id).includes(find.id)

/**
 * This module stores unconfirmed transactions, so it does not persist currently:
 * it is not required and avoids managing their lifecycle when they are confirmed.
 *
 * Internally the transactions are stored aggregated by `profileId``
 */
export default {
  namespaced: true,

  state: {
    transactions: {},
    // TODO This should not be stored here: it depends on the network, not the transactions
    staticFees: {}
  },

  getters: {
    byAddress: (state, _, __, rootGetters) => (address, { includeExpired } = {}) => {
      const profileId = rootGetters['session/profileId']
      if (!profileId || !state.transactions[profileId]) {
        return []
      }

      const transactions = state.transactions[profileId].filter(transaction => {
        return transaction.recipient === address || transaction.sender === address
      }).map(transaction => {
        transaction.isSender = transaction.sender === address
        transaction.isRecipient = transaction.recipient === address
        transaction.totalAmount = transaction.amount + transaction.fee

        return transaction
      })

      if (includeExpired) {
        return transactions
      }

      return transactions.filter(transaction => !transaction.isExpired)
    },

    byProfileId: (state, _, __, rootGetters) => (profileId, { includeExpired } = {}) => {
      if (!state.transactions[profileId]) {
        return []
      }

      const addresses = rootGetters['wallet/byProfileId'](profileId).map(wallet => {
        return wallet.address
      })

      const transactions = state.transactions[profileId].map(transaction => {
        transaction.isSender = addresses.includes(transaction.sender)
        transaction.isRecipient = addresses.includes(transaction.recipient)
        transaction.totalAmount = transaction.amount + transaction.fee

        return transaction
      })

      if (includeExpired) {
        return transactions
      }

      return transactions.filter(transaction => !transaction.isExpired)
    },

    /**
     * Get a static fee based on type.
     * @param  {Number} type
     * @return {(Number|null)}
     */
    staticFee: (state, _, __, rootGetters) => (type) => {
      const networkId = rootGetters['session/profile'].networkId
      if (!networkId || !state.staticFees[networkId]) {
        return null
      }

      return state.staticFees[networkId][type]
    }
  },

  mutations: {
    CREATE (state, transaction) {
      if (!state.transactions[transaction.profileId]) {
        Vue.set(state.transactions, transaction.profileId, [])
      }

      if (includes(state.transactions[transaction.profileId], transaction)) {
        throw new Error(`Cannot create transaction '${transaction.id}' - it already exists`)
      }

      state.transactions[transaction.profileId].push(transaction)
    },
    STORE (state, transaction) {
      if (!state.transactions[transaction.profileId]) {
        Vue.set(state.transactions, transaction.profileId, [])
      }
      state.transactions[transaction.profileId] = unionBy([transaction, ...state.transactions[transaction.profileId]], 'id')
    },
    UPDATE (state, transaction) {
      if (!includes(state.transactions[transaction.profileId], transaction)) {
        throw new Error(`Cannot update transaction '${transaction.id}' - it does not exist on the state`)
      }
      state.transactions[transaction.profileId] = unionBy([transaction, ...state.transactions[transaction.profileId]], 'id')
    },
    DELETE (state, transaction) {
      const index = findIndex(state.transactions[transaction.profileId], { id: transaction.id })
      if (index === -1) {
        throw new Error(`Cannot delete transaction '${transaction.id}' - it does not exist on the state`)
      }
      state.transactions[transaction.profileId].splice(index, 1)
    },
    SET_STATIC_FEES (state, data) {
      state.staticFees[data.networkId] = data.staticFees
    }
  },

  actions: {
    create ({ commit }, transaction) {
      const data = TransactionModel.deserialize(transaction)
      commit('CREATE', data)

      eventBus.emit(`wallet:${transaction.sender}:transaction:new`)

      return data
    },

    store ({ commit }, transactions) {
      commit('STORE', transactions)
    },

    update ({ commit }, transaction) {
      const data = TransactionModel.deserialize(transaction)
      commit('UPDATE', data)

      return data
    },

    processVotes ({ dispatch, rootGetters }, transactions = []) {
      const unconfirmedVotes = rootGetters['session/unconfirmedVotes']
      const profile = rootGetters['session/profile']

      if (!unconfirmedVotes || !unconfirmedVotes.length || !profile) {
        return
      }

      const votes = transactions.filter(tx => tx.type === config.TRANSACTION_TYPES.VOTE)
      if (!votes.length) {
        return
      }

      const ids = votes.map(vote => vote.id)
      const pendingVotes = unconfirmedVotes.filter(vote => {
        return !ids.includes(vote.id)
      })

      dispatch('session/setUnconfirmedVotes', pendingVotes, { root: true })

      dispatch('profile/update', {
        ...profile,
        unconfirmedVotes: pendingVotes
      }, { root: true })
    },

    async clearUnconfirmedVotes ({ dispatch, rootGetters }) {
      const unconfirmedVotes = rootGetters['session/unconfirmedVotes']
      const profile = rootGetters['session/profile']

      if (!unconfirmedVotes || !unconfirmedVotes.length || !profile) {
        return
      }

      const pendingVotes = unconfirmedVotes.filter(vote => {
        if (!vote.timestamp) {
          return false
        }

        return !dayjs().isAfter(dayjs(vote.timestamp).add(6, 'hour'))
      })

      await dispatch('session/setUnconfirmedVotes', pendingVotes, { root: true })
      await dispatch('profile/update', {
        ...profile,
        unconfirmedVotes: pendingVotes
      }, { root: true })
    },

    clearExpired ({ commit, getters, rootGetters }) {
      const expired = []
      const profileId = rootGetters['session/profileId']
      const threshold = dayjs().subtract(config.APP.transactionExpiryMinutes, 'minute')
      for (const transaction of getters.byProfileId(profileId)) {
        if (dayjs(transaction.timestamp).isBefore(threshold)) {
          transaction.isExpired = true
          expired.push(transaction.id)
          commit('UPDATE', transaction)
        }
      }

      return expired
    },

    delete ({ commit }, transaction) {
      commit('DELETE', transaction)
    },

    deleteBulk ({ commit }, { transactions = [], profileId = null }) {
      for (const transaction of transactions) {
        transaction.profileId = profileId
        try {
          commit('DELETE', transaction)
        } catch (error) {
          //
        }
      }
    },

    /**
     * Update static fees from API and store against a network.
     * @return {void}
     */
    async updateStaticFees ({ commit, rootGetters }) {
      commit('SET_STATIC_FEES', {
        networkId: rootGetters['session/profile'].networkId,
        staticFees: await this._vm.$client.fetchStaticFees()
      })
    }
  }
}
