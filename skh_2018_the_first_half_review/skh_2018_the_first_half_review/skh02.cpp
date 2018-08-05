#define _CRT_SECURE_NO_WARNINGS

#include <stdio.h>
#include <stdlib.h>

int hextodec(char* phex, int pos) {
	int v = 0;
	if (*phex == NULL) {
		return 0;
	}
	else if (*phex >= 'A' && *phex <= 'F') {
		v= ((int)(*phex - 'A') + 10);
	}
	else if (*phex >= '0' && *phex <= '9') {
		v= (int)(*phex - '0');
	}
	else {
		v= 0;
	}
	//printf("%d ", v << (4 * pos));
	return  ( v << (4 * pos) ) + hextodec(phex + 1, pos - 1);
}
int cntPos(char* phex) {
	//printf("%c ", *phex);
	if (*phex == NULL) {
		return 0;
	}
	else {
		return 1 + cntPos(phex + 1);
	}
}

int main() {
	char strinput[10];
	int val = 0, cnt = 0;
	// GET INPUT
	scanf("%s",strinput);
	
	// convert to decimal
	cnt = cntPos(strinput + 2);
	val = hextodec(strinput+2,cnt-1);

	printf("°á°ú : %d\n", val);
	system("pause");
	return 0;
}