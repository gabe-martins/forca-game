# Forca em Rede

Jogo de forca para 2 a 16 pessoas em uma sala compartilhada. Basta um computador com Node.js 18 ou superior para hospedar. Os jogadores entram pelo navegador de um computador ou celular na mesma rede.

## Como iniciar

1. No Windows, dê dois cliques em `iniciar.cmd`. Em qualquer sistema, abra o terminal nesta pasta e rode `node server.js`.
2. No computador anfitrião, abra o endereço indicado como **Neste computador**, normalmente `http://localhost:3000`.
3. Envie aos demais jogadores o endereço indicado como **Na rede local**. Ele também aparece na sala de espera, ao lado do botão **Copiar**.
4. Mantenha o servidor aberto durante o jogo. Use `Ctrl+C` para encerrar.

O jogo roda sem instalar pacotes. Para testar no mesmo computador, abra a página em abas separadas e use nomes diferentes. Se outros aparelhos não conseguirem abrir a página, confira se estão na mesma rede e se o firewall do anfitrião permite conexões de entrada para o Node.js na rede privada.

## Como jogar

- Cada jogador digita o nome e recebe uma sessão na aba. Recarregar a página recupera a sessão enquanto ela estiver disponível no servidor.
- A primeira pessoa a entrar vira anfitriã e inicia a rodada. O jogo sorteia quem define a palavra ou expressão e, se quiser, uma dica.
- Os demais escolhem uma letra por turno. O turno passa a cada palpite. Letras sem acento revelam as equivalentes acentuadas, como **A** para **Ã**.
- O grupo vence ao descobrir a palavra. A rodada termina na sexta letra errada. O anfitrião pode iniciar uma nova rodada e fazer outro sorteio.
- Quem entra durante a partida acompanha a rodada atual e joga a partir da próxima. Se a pessoa da vez sair, a rodada avança para quem estiver disponível.

A sala e as sessões ficam na memória do servidor. Reiniciar o processo abre uma nova sala.

## Docker no servidor da rede local

Copie esta pasta para o servidor `192.168.15.9`. No terminal do servidor, execute dentro da pasta com o Docker e o plugin Docker Compose disponíveis:

```sh
docker compose up -d --build
docker compose ps
```

Abra [Forca em Rede](http://192.168.15.9:9079) de um dispositivo na rede local. O Compose publica a porta `9079` no IP do servidor e encaminha para a porta `3000` do contêiner. Use `docker compose logs` para consultar os logs e `docker compose stop` para parar o jogo.
