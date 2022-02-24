#pip install beautifulsoup4

import os
import requests
from bs4 import BeautifulSoup
# Connect ----------------------------------------------------------------------
import xrpl
testnet_url = "https://s.altnet.rippletest.net:51234"
client = xrpl.clients.JsonRpcClient(testnet_url)

# Get credentials from the Testnet Faucet --------------------------------------
# For production, instead create a Wallet instance
faucet_url = "https://faucet.altnet.rippletest.net/accounts"
print("Getting 2 new accounts from the Testnet faucet...")
from xrpl.wallet import generate_faucet_wallet
cold_wallet = generate_faucet_wallet(client, debug=True)
hot_wallet = generate_faucet_wallet(client, debug=True)
print ("cold_wallet = ", cold_wallet)

# faucet_url = "https://faucet.altnet.rippletest.net/accounts"
# print("Getting 2 new accounts from the Testnet faucet...")
# from xrpl.wallet import generate_faucet_wallet
# nft_cold_wallet = generate_faucet_wallet(client, debug=True)
# nft_hot_wallet = generate_faucet_wallet(client, debug=True)


def scrapeSite():
    url = "https://www.google.com/"
    reponse = requests.get(url)

    if reponse.ok:
        soup = BeautifulSoup(reponse.text, "lxml")
        title = str(soup.find("title"))

        title = title.replace("<title>", "")
        title = title.replace("</title>", "")
        print("The title is : " + str(title))

    os.system("pause")

def scrapeSite2():
    url = "http://xls20-sandbox.rippletest.net:51234"
    response = requests.get(url)

    print (response)

    if response.ok:
        soup = BeautifulSoup(response.text, "lxml")
        title = str(soup.find("title"))

        title = title.replace("<title>", "")
        title = title.replace("</title>", "")
        print("The title is : " + str(title))


#python (code name).py
#WebSocket
#wss://xls20-sandbox.rippletest.net:51233

#JSON-RPC
#http://xls20-sandbox.rippletest.net:51234

#scrapeSite2()